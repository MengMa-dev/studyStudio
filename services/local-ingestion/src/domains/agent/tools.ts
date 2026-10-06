import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { estimateTokens } from "../../search/chunk.js";
import { searchFts } from "../../search/fts.js";
import { getKbEntryDetail } from "../kb/index.js";
import type { IndexContext } from "../organize/kb-index.js";
import { parseSections, SEED_KINDS, stripSectionMarkers } from "@study-studio/shared";
import { normalizeEntryName } from "../organize/normalize.js";
import type { WorkUnit } from "../organize/process.js";
import { NAME_MATCH_SIMILARITY, RetrievalCache, retrieveCandidates } from "../organize/retrieve.js";
import { ENTRY_OWNER } from "../organize/runtime-types.js";
import { categoryName, categoryNames, fuzzyNotesNear, kbIgnoreNames, listAliveEntries, loadEntry, type OrganizeItem } from "../organize/store.js";
import { addToInbox } from "./capture.js";
import { AgentToolError } from "./errors.js";
import { buildGuidelines } from "./guidelines.js";
import { finishAgentSession, startAgentSession } from "./session.js";
import {
  addRelation,
  addRelationSchema,
  attachSource,
  attachSourceSchema,
  finishUnit,
  finishUnitSchema,
  writeEntry,
  writeEntrySchema
} from "./submit.js";
import { findUnit, pendingUnits, unitKey } from "./units.js";

/** MCP tool definitions. Results are wrapped as `{ ok: true, ...payload }` / `{ ok: false, error, message, details? }`. */

export const AGENT_SKILL_VERSION = 3;

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
  description: "获取整理规范（LLM Wiki 维护者的流程与写作规范）。整理前先调用，后续汇报方案与写入严格按其规范。",
  input: z.object({}),
  handler: async () => buildGuidelines()
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
  description: "读取单元全文（网页 / 文档为 text，问答为 turns：每轮问题与完整回答）、用户划线、条目备注与同期模糊备注。",
  input: z.object({ unit_key: z.string().min(1) }),
  handler: async (deps, input) => {
    const unit = requireUnit(deps.db, input.unit_key);
    const anchor = unit.items[0]!;
    const highlights = unit.items.flatMap((item) => item.highlights);
    const notes = unit.items.flatMap((item) => item.itemNotes.map((note) => note.text));
    const conversation = anchor.type === "conversation";
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
      fuzzy_notes: fuzzyNotesNear(deps.db, anchor.capturedAt).map((note) => note.text),
      text: conversation ? null : anchor.body,
      turns: conversation
        ? unit.items.map((item, index) => ({ turn_item_id: item.id, turn_index: index + 1, question: item.question ?? item.title, answer: item.body }))
        : null
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
  description: "读取词条详情（正文、章节 sections、关系），用于与新内容对比；attach_source 的 section_id 从 sections 中取。",
  input: z.object({ entry_id: z.string().min(1) }),
  handler: async (deps, input) => {
    const detail = getKbEntryDetail(deps.db, input.entry_id);
    const raw = loadEntry(deps.db, input.entry_id)?.body;
    if (!detail || raw === undefined) throw new AgentToolError("entry_not_found", "词条不存在或已删除");
    return {
      entry_id: detail.id,
      name: detail.name,
      aliases: detail.aliases,
      kind: detail.kind,
      category: detail.categoryName,
      summary: detail.summary,
      body: stripSectionMarkers(raw),
      sections: parseSections(raw)
        .filter((section) => section.id)
        .map((section) => ({ section_id: section.id, heading: section.heading, source_item_ids: section.sourceItemIds })),
      user_edited: detail.userEdited,
      relations: detail.relations.map((relation) => ({ entry_id: relation.id, name: relation.name, type: relation.type, direction: relation.direction }))
    };
  }
});

const listVocabTool = defineAgentTool({
  name: "list_vocab",
  description: "列出可用词条类型、分类与忽略名单；选择 kind / 分类时优先复用。",
  input: z.object({}),
  handler: async (deps) => ({ kinds: [...SEED_KINDS], categories: categoryNames(deps.db), ignored_names: kbIgnoreNames(deps.db) })
});

const startSessionTool = defineAgentTool({
  name: "start_session",
  description: "开始整理会话，返回 run_id（后续写入工具与 finish_session 需传入）。自动整理或其他会话运行中时返回 busy。",
  input: z.object({ client: z.string().max(64).optional() }),
  handler: async (deps, input) => {
    const started = startAgentSession(deps.db, input.client ?? null);
    if (!started.ok) throw new AgentToolError("busy", "自动整理或其他 Agent 会话正在运行，请稍后再试", { active_run_id: started.activeRunId });
    return { run_id: started.runId, skill_version: AGENT_SKILL_VERSION };
  }
});

const finishSessionTool = defineAgentTool({
  name: "finish_session",
  description: "结束整理会话并返回本次统计。summary 可说明未完成或跳过的单元。",
  input: z.object({ run_id: z.string().min(1), summary: z.string().optional() }),
  handler: async (deps, input) => ({ stats: finishAgentSession(deps.db, input.run_id, input.summary ?? null) })
});

const writeEntryTool = defineAgentTool({
  name: "write_entry",
  description:
    "向词条追加章节（用户确认方案后调用）。填 entry_id 补充已有词条，或填 new 新建词条（name、aliases、kind、category、summary；与已有名称 / 别名重名时返回 name_exists 与 entry_id）。sections 每项为一个 ## 章节：heading、markdown（章节内只用 ### 及以下标题）、source_item_ids（内容来自的条目 / 问答轮 id，须属于该单元）。服务端生成章节标记，返回 section_id。",
  input: writeEntrySchema,
  handler: (deps, input) => writeEntry(deps, input)
});

const attachSourceTool = defineAgentTool({
  name: "attach_source",
  description: "来源内容已被某个已有章节完整覆盖时，给该章节追加来源（不写正文）。section_id 从 get_entry 的 sections 中取，item_ids 须属于该单元。",
  input: attachSourceSchema,
  handler: async (deps, input) => attachSource(deps, input)
});

const addRelationTool = defineAgentTool({
  name: "add_relation",
  description: "建立词条关系。from / to 填 entry_id 或词条名；type：prerequisite（前置）/ part_of（组成部分）/ contrasts（对比）/ related（相关）；description 一句话说明关系。",
  input: addRelationSchema,
  handler: async (deps, input) => addRelation(deps, input)
});

const finishUnitTool = defineAgentTool({
  name: "finish_unit",
  description:
    "结束一个单元并更新条目状态：organized（已写入词条）/ rejected（低价值，附 reject_reason）/ not_learning（非学习内容）/ skipped（用户要求跳过，不改状态）。reason 简述理由。",
  input: finishUnitSchema,
  handler: async (deps, input) => finishUnit(deps, input)
});

const addToInboxTool = defineAgentTool({
  name: "add_to_inbox",
  description:
    "把当前 Agent 对话或本地文本文件原文录入收件箱，返回 unit_key（之后按整理流程处理）。source=conversation 需 turns（每轮用户原话 question 与回答原文 answer，逐字照录不改写）；source=file 需 file_path（绝对路径，服务端直接读取原文）。agent 填当前 Agent 名（Cursor / Claude Code / Codex），作为收件箱来源。",
  input: z.object({
    agent: z.string().trim().min(1).max(64),
    source: z.enum(["conversation", "file"]),
    turns: z.array(z.object({ question: z.string().trim().min(1), answer: z.string().trim().min(1) })).max(200).optional(),
    file_path: z.string().min(1).optional()
  }),
  handler: async (deps, input) => {
    if (input.source === "conversation" && !input.turns?.length) throw new AgentToolError("invalid_input", "source=conversation 需要 turns");
    if (input.source === "file" && !input.file_path) throw new AgentToolError("invalid_input", "source=file 需要 file_path");
    const ids = addToInbox(
      deps.db,
      input.source === "file" ? { agent: input.agent, source: "file", filePath: input.file_path! } : { agent: input.agent, source: "conversation", turns: input.turns! },
      deps.now()
    );
    const unit = pendingUnits(deps.db).find((candidate) => candidate.items.some((item) => item.id === ids[0]));
    return { unit_key: unit ? unitKey(unit) : ids[0], item_ids: ids };
  }
});

export function agentTools(): AgentTool<any>[] {
  return [
    getGuidelinesTool,
    listInboxTool,
    getUnitTool,
    searchKbTool,
    getEntryTool,
    listVocabTool,
    startSessionTool,
    finishSessionTool,
    writeEntryTool,
    attachSourceTool,
    addRelationTool,
    finishUnitTool,
    addToInboxTool
  ];
}
