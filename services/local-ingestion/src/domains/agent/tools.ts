import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { knowledgeComposeOutputSchema } from "../../ai/prompts/schemas.draft.js";
import { estimateTokens } from "../../search/chunk.js";
import { searchFts } from "../../search/fts.js";
import { getKbEntryDetail } from "../kb/index.js";
import { chunkUnit } from "../organize/chunk.js";
import type { IndexContext } from "../organize/kb-index.js";
import { kindVocabulary } from "../organize/kinds.js";
import { normalizeEntryName } from "../organize/normalize.js";
import type { WorkUnit } from "../organize/process.js";
import { NAME_MATCH_SIMILARITY, RetrievalCache, retrieveCandidates } from "../organize/retrieve.js";
import { getRunRow } from "../organize/run-store.js";
import { ENTRY_OWNER } from "../organize/runtime-types.js";
import { rejectReasonSchema } from "../organize/schemas.js";
import { categoryName, categoryNames, kbIgnoreNames, listAliveEntries, outlineOf, type OrganizeItem } from "../organize/store.js";
import { AgentToolError } from "./errors.js";
import { buildGuidelines } from "./guidelines.js";
import { finishAgentSession, startAgentSession } from "./session.js";
import { submitDecision, submitDecisionSchema, submitPointsSchema } from "./submit.js";
import { findUnit, pendingUnits, unitKey } from "./units.js";

/** MCP tool definitions (16). Results are wrapped as `{ ok: true, ...payload }` / `{ ok: false, error, message, details? }`. */

export const AGENT_SKILL_VERSION = 1;

export type AgentToolDeps = { db: DatabaseSync; indexCtx: IndexContext | null; now: () => Date };

export type AgentTool<I> = {
  name: string;
  description: string;
  /** Object schema: also the MCP `inputSchema`. */
  input: z.ZodType<I>;
  handler: (deps: AgentToolDeps, input: I) => Promise<Record<string, unknown>>;
};

export type AgentToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: string; message: string; details?: unknown };

export function defineAgentTool<I>(tool: AgentTool<I>): AgentTool<I> {
  return tool;
}

export async function runAgentTool<I>(tool: AgentTool<I>, deps: AgentToolDeps, input: I): Promise<AgentToolResult> {
  try {
    return { ok: true, ...(await tool.handler(deps, input)) };
  } catch (error) {
    if (error instanceof AgentToolError) {
      return { ok: false, error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
    }
    return { ok: false, error: "internal_error", message: error instanceof Error ? error.message : String(error) };
  }
}

const PARTIAL_MATCH_SIMILARITY = 0.6;
const SEARCH_OWNERS = new Set<string>([ENTRY_OWNER.summary, ENTRY_OWNER.name, ENTRY_OWNER.body]);

function unitTokens(unit: WorkUnit): number {
  return estimateTokens(unit.items.map((item) => [item.question ?? "", item.body].join("\n")).join("\n\n"));
}

function requireUnit(db: DatabaseSync, key: string): WorkUnit {
  const unit = findUnit(db, key);
  if (!unit) throw new AgentToolError("unit_not_found", "单元不存在或已整理，请重新调用 list_inbox");
  return unit;
}

function queryItem(query: string, now: Date): OrganizeItem {
  return {
    id: "agent_query",
    type: "webpage",
    title: query,
    url: null,
    site: null,
    capturedAt: now.toISOString(),
    status: "pending",
    dirty: false,
    contentHash: null,
    body: "",
    plainText: null,
    markdown: null,
    question: null,
    conversationId: null,
    readingSeconds: 0,
    highlights: [],
    itemNotes: [],
    exposure: []
  };
}

/** Vector + exact name recall (when an index context exists), plus FTS and partial name / alias matches. */
async function searchKb(deps: AgentToolDeps, query: string, limit: number) {
  const entries = listAliveEntries(deps.db);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const scores = new Map<string, number>();
  const bump = (id: string, score: number) => {
    if (byId.has(id) && score > (scores.get(id) ?? -1)) scores.set(id, score);
  };
  if (deps.indexCtx) {
    for (const candidate of await retrieveCandidates(deps.indexCtx, new RetrievalCache(), [queryItem(query, deps.now())], null, entries, deps.now())) {
      bump(candidate.entry_id, candidate.similarity);
    }
  }
  const term = normalizeEntryName(query);
  for (const entry of entries) {
    const keys = [entry.name, ...entry.aliases].map(normalizeEntryName).filter(Boolean);
    if (keys.includes(term)) bump(entry.id, NAME_MATCH_SIMILARITY);
    else if (term && keys.some((key) => key.includes(term) || term.includes(key))) bump(entry.id, PARTIAL_MATCH_SIMILARITY);
  }
  if (deps.indexCtx?.searchIndex) {
    const hits = searchFts(deps.db, query, { limit: limit * 5, anyToken: true }).filter((hit) => SEARCH_OWNERS.has(hit.ownerType));
    const max = Math.max(...hits.map((hit) => hit.score), 1e-9);
    for (const hit of hits) bump(hit.ownerId, (PARTIAL_MATCH_SIMILARITY * hit.score) / max);
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const entry = byId.get(id)!;
      return {
        entry_id: id,
        name: entry.name,
        aliases: entry.aliases,
        kind: entry.kind,
        category: categoryName(deps.db, entry.categoryId),
        summary: entry.summary,
        score: Math.round(score * 1000) / 1000
      };
    });
}

const getGuidelinesTool = defineAgentTool({
  name: "get_guidelines",
  description: "获取整理规则（判定 / 抽取知识点 / 组织写作 / Agent 补充约束）。整理前先调用，后续判断与写作严格按其规则。",
  input: z.object({ stage: z.enum(["triage", "extract", "compose", "all"]).optional() }),
  handler: async (_deps, input) => buildGuidelines(input.stage ?? "all")
});

const listInboxTool = defineAgentTool({
  name: "list_inbox",
  description: "列出待整理单元（收件箱中 pending / failed 条目；同一对话的多轮合为一个单元）。用 next_cursor 翻页。",
  input: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().optional() }),
  handler: async (deps, input) => {
    const limit = input.limit ?? 20;
    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
    const units = pendingUnits(deps.db);
    const page = units.slice(offset, offset + limit);
    return {
      units: page.map((unit) => {
        const anchor = unit.items[0]!;
        return {
          unit_key: unitKey(unit),
          item_ids: unit.items.map((item) => item.id),
          type: anchor.type,
          title: anchor.title,
          url: anchor.url,
          captured_at: anchor.capturedAt,
          has_note: unit.items.some((item) => item.itemNotes.length > 0),
          has_highlight: unit.items.some((item) => item.highlights.length > 0),
          tokens: unitTokens(unit)
        };
      }),
      next_cursor: offset + limit < units.length ? String(offset + limit) : null
    };
  }
});

const getUnitTool = defineAgentTool({
  name: "get_unit",
  description: "读取单元全文（分块）、用户划线与笔记。引文须从 chunks 原文摘录。",
  input: z.object({ unit_key: z.string().min(1) }),
  handler: async (deps, input) => {
    const unit = requireUnit(deps.db, input.unit_key);
    const anchor = unit.items[0]!;
    const highlights = unit.items.flatMap((item) => item.highlights);
    const notes = unit.items.flatMap((item) => item.itemNotes.map((note) => note.text));
    return {
      unit_key: unitKey(unit),
      item_ids: unit.items.map((item) => item.id),
      type: anchor.type,
      title: anchor.title,
      url: anchor.url,
      has_note: notes.length > 0,
      has_highlight: highlights.length > 0,
      user_highlights: highlights,
      user_note: notes.length > 0 ? notes.join("\n\n") : null,
      chunks: chunkUnit(unit)
    };
  }
});

const searchKbTool = defineAgentTool({
  name: "search_kb",
  description: "按概念名 / 关键词检索知识库已有词条，用于决定补充已有词条还是新建。",
  input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
  handler: async (deps, input) => ({ entries: await searchKb(deps, input.query, input.limit ?? 8) })
});

const getEntryTool = defineAgentTool({
  name: "get_entry",
  description: "读取词条详情（正文、大纲、关系），用于与新内容对比。",
  input: z.object({ entry_id: z.string().min(1) }),
  handler: async (deps, input) => {
    const detail = getKbEntryDetail(deps.db, input.entry_id);
    if (!detail) throw new AgentToolError("entry_not_found", "词条不存在或已删除");
    return {
      entry_id: detail.id,
      name: detail.name,
      aliases: detail.aliases,
      kind: detail.kind,
      category: detail.categoryName,
      summary: detail.summary,
      body: detail.bodyMarkdown,
      outline: outlineOf(detail.bodyMarkdown),
      user_edited: detail.userEdited,
      relations: detail.relations.map((relation) => ({ entry_id: relation.id, name: relation.name, type: relation.type, direction: relation.direction }))
    };
  }
});

const listVocabTool = defineAgentTool({
  name: "list_vocab",
  description: "列出可用词条类型、分类与忽略名单；选择 kind / 分类时优先复用。",
  input: z.object({}),
  handler: async (deps) => ({ kinds: kindVocabulary(deps.db), categories: categoryNames(deps.db), ignored_names: kbIgnoreNames(deps.db) })
});

const startSessionTool = defineAgentTool({
  name: "start_session",
  description: "开始整理会话，返回 run_id（后续 submit_decision / finish_session 需传入）。自动整理或其他会话运行中时返回 busy。",
  input: z.object({ client: z.string().max(64).optional() }),
  handler: async (deps, input) => {
    const started = startAgentSession(deps.db, input.client ?? null);
    if (!started.ok) throw new AgentToolError("busy", "自动整理或其他 Agent 会话正在运行，请稍后再试", { active_run_id: started.activeRunId });
    return { run_id: started.runId, skill_version: AGENT_SKILL_VERSION };
  }
});

const finishSessionTool = defineAgentTool({
  name: "finish_session",
  description: "结束整理会话并返回本次统计。summary 可说明未完成或多次校验失败的单元。",
  input: z.object({ run_id: z.string().min(1), summary: z.string().optional() }),
  handler: async (deps, input) => ({ stats: finishAgentSession(deps.db, input.run_id, input.summary ?? null) })
});

const submitDecisionTool = defineAgentTool({
  name: "submit_decision",
  description:
    "提交一个单元的整理结果（每单元一次）。decision=compose 需 value_score / thesis / points / compose；duplicate 需 target_entry_ids（划线 / 笔记过的单元不能判 duplicate）；reject 需 reject_reason；not_learning 只需 reason。校验失败不落库，按返回的 error / details 修正后重交。",
  // MCP clients only see object schemas; the discriminated union is enforced in the handler.
  input: z.object({
    run_id: z.string(),
    unit_key: z.string(),
    decision: z.enum(["compose", "duplicate", "reject", "not_learning"]),
    reason: z.string(),
    value_score: z.number().min(0).max(1).optional(),
    thesis: z.string().optional(),
    points: submitPointsSchema.optional(),
    compose: knowledgeComposeOutputSchema.optional(),
    target_entry_ids: z.array(z.string()).optional(),
    evidence: z.array(z.object({ entry_id: z.string(), quote: z.string() })).optional(),
    reject_reason: rejectReasonSchema.optional()
  }),
  handler: async (deps, input) => {
    const parsed = submitDecisionSchema.safeParse(input);
    if (!parsed.success) throw new AgentToolError("invalid_input", "参数不符合该 decision 的要求", z.treeifyError(parsed.error));
    const model = getRunRow(deps.db, input.run_id)?.model ?? "";
    return submitDecision(deps, parsed.data, model.startsWith("agent:") ? model.slice("agent:".length) : null);
  }
});

/** Read + session tools; write tools are appended here. */
export function agentTools(): AgentTool<any>[] {
  return [getGuidelinesTool, listInboxTool, getUnitTool, searchKbTool, getEntryTool, listVocabTool, startSessionTool, finishSessionTool, submitDecisionTool];
}
