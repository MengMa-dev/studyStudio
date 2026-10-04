import type { DatabaseSync } from "node:sqlite";
import type { OrganizeDecision, OrganizeRunStats } from "@study-studio/shared";
import { z } from "zod";
import { knowledgeComposeOutputSchema, POINT_IMPORTANCE } from "../../ai/prompts/schemas.draft.js";
import { commitUnit } from "../organize/commit.js";
import { assembleResult, missingFeedback, missingPoints, validateCompose, type KnowledgePoint } from "../organize/coverage.js";
import {
  integrateExtraction,
  recordDuplicate,
  recordRejection,
  type IntegrationContext,
  type IntegrationResult,
  type ResultRecord
} from "../organize/integrate.js";
import { indexEntryBody, vectorRecall, type IndexContext } from "../organize/kb-index.js";
import { tryEmbed } from "../organize/llm.js";
import { collectPoints, type WorkUnit } from "../organize/process.js";
import { getRunRow, setJob, toRunSummary, updateRun, type JobStatus } from "../organize/run-store.js";
import { ENTRY_OWNER } from "../organize/runtime-types.js";
import { rejectReasonSchema } from "../organize/schemas.js";
import { kbIgnoreNames, listAliveEntries, loadEntry } from "../organize/store.js";
import { AgentToolError } from "./errors.js";
import { AGENT_GUIDELINES_VERSION } from "./guidelines.js";
import { requireAgentRun, touchAgentRun } from "./session.js";
import { findUnit } from "./units.js";

const pointInput = z.object({
  statement: z.string().min(1),
  quote: z.string().min(1),
  section: z.string().nullable(),
  concept: z.string().min(1),
  importance: z.enum(POINT_IMPORTANCE),
  turn_item_id: z.string().nullable()
});

export const submitDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    run_id: z.string(),
    unit_key: z.string(),
    decision: z.literal("compose"),
    value_score: z.number().min(0).max(1),
    reason: z.string(),
    thesis: z.string(),
    /** Ordered; compose refers to them as p1…pn by position. */
    points: z.array(pointInput).min(1),
    compose: knowledgeComposeOutputSchema
  }),
  z.object({
    run_id: z.string(),
    unit_key: z.string(),
    decision: z.literal("duplicate"),
    reason: z.string(),
    target_entry_ids: z.array(z.string()).min(1),
    evidence: z.array(z.object({ entry_id: z.string(), quote: z.string() })).default([])
  }),
  z.object({ run_id: z.string(), unit_key: z.string(), decision: z.literal("reject"), reason: z.string(), reject_reason: rejectReasonSchema }),
  z.object({ run_id: z.string(), unit_key: z.string(), decision: z.literal("not_learning"), reason: z.string() })
]);

export type SubmitDecisionInput = z.infer<typeof submitDecisionSchema>;
export type SubmitDeps = { db: DatabaseSync; indexCtx: IndexContext | null; now: () => Date };
export type SubmitResult = {
  ok: true;
  entry_changes: Array<{ entry_id: string; name: string; change: string }>;
  edges_created: number;
};

type Ctx = { deps: SubmitDeps; runId: string; unit: WorkUnit; integration: IntegrationContext; record: ResultRecord };

const normalizeSpace = (text: string) => text.replace(/\s+/g, " ").trim();

function unitText(unit: WorkUnit): string {
  return normalizeSpace(unit.items.flatMap((item) => [item.question ?? "", item.body]).join("\n"));
}

function unquoted(unit: WorkUnit, quotes: string[]): number[] {
  const text = unitText(unit);
  return quotes.flatMap((quote, index) => (text.includes(normalizeSpace(quote)) ? [] : [index]));
}

function hasUserMarks(unit: WorkUnit): boolean {
  return unit.items.some((item) => item.highlights.length > 0 || item.itemNotes.length > 0);
}

function locateUnit(db: DatabaseSync, key: string): WorkUnit {
  const unit = findUnit(db, key);
  if (unit) return unit;
  const row = db.prepare("SELECT organize_status FROM items WHERE id = ? AND deleted_at IS NULL").get(key) as { organize_status: string } | undefined;
  if (row) throw new AgentToolError("already_organized", "该单元已整理过，请用 list_inbox 取下一个单元");
  throw new AgentToolError("unit_not_found", "单元不存在，请重新调用 list_inbox 获取 unit_key");
}

function bumpStats(db: DatabaseSync, runId: string, update: (stats: OrganizeRunStats) => void): void {
  const row = getRunRow(db, runId);
  if (!row) return;
  const stats = toRunSummary(row).stats;
  update(stats);
  updateRun(db, runId, { stats });
}

async function nameSimilarities(indexCtx: IndexContext | null, names: string[]): Promise<IntegrationContext["nameSimilarities"]> {
  const out: IntegrationContext["nameSimilarities"] = new Map();
  if (!indexCtx?.searchIndex) return out;
  for (const name of names) {
    const vector = await tryEmbed(indexCtx.llm, name);
    if (!vector) continue;
    out.set(
      name,
      [...vectorRecall(indexCtx, vector, [ENTRY_OWNER.name], 10)].map(([entry_id, similarity]) => ({ entry_id, similarity }))
    );
  }
  return out;
}

async function commit(ctx: Ctx, result: IntegrationResult, status: JobStatus, decision: OrganizeDecision): Promise<SubmitResult> {
  const { db, indexCtx } = ctx.deps;
  const items = ctx.unit.items;
  if (indexCtx) {
    const indexed = await commitUnit({ db, indexCtx, runId: ctx.runId }, items, result, status);
    for (const entryId of indexed) {
      const entry = loadEntry(db, entryId);
      if (entry) await indexEntryBody(indexCtx, entry).catch(() => undefined);
    }
  } else {
    for (const item of items) setJob(db, ctx.runId, "item", item.id, status);
  }
  bumpStats(db, ctx.runId, (stats) => {
    stats.items.total += items.length;
    if (status === "ingested") stats.items.ingested += items.length;
    else stats.items.rejected += items.length;
    stats.decisions[decision === "not_learning" ? "notLearning" : decision] += 1;
    for (const change of result.entryChanges) {
      if (change.change === "created") stats.kb.entriesCreated += 1;
      if (change.change === "supplemented") stats.kb.entriesSupplemented += 1;
    }
    stats.kb.relationsCreated += result.edgesCreated;
  });
  return {
    ok: true,
    entry_changes: result.entryChanges.map((change) => ({ entry_id: change.entryId, name: change.name, change: change.change })),
    edges_created: result.edgesCreated
  };
}

async function submitCompose(ctx: Ctx, input: Extract<SubmitDecisionInput, { decision: "compose" }>): Promise<SubmitResult> {
  const { db } = ctx.deps;
  const points: KnowledgePoint[] = collectPoints(ctx.unit, [{ points: input.points }]);
  const badQuotes = unquoted(
    ctx.unit,
    points.map((point) => point.quote)
  );
  if (badQuotes.length) {
    throw new AgentToolError(
      "quote_not_found",
      `以下知识点的 quote 不是单元原文摘录，请逐字摘录：${badQuotes.map((index) => points[index]!.id).join("、")}`,
      badQuotes
    );
  }
  const known = new Set(listAliveEntries(db).map((entry) => entry.id));
  const problems = validateCompose(input.compose, points, known);
  if (problems.length) throw new AgentToolError("invalid_compose", problems.join("\n"), problems);
  const missing = missingPoints(input.compose, points);
  if (missing.length) throw new AgentToolError("missing_points", missingFeedback(missing), missing.map((point) => point.id));

  const output = assembleResult(input.compose, points, { item_id: ctx.unit.items[0]!.id, value_score: input.value_score, reason: input.reason });
  const record = { ...ctx.record, output: { raw: { thesis: input.thesis, points, compose: input.compose } } };
  if (output.decision === "reject") {
    const result = recordRejection(ctx.integration, ctx.unit.items, { ...record, decision: "reject", rejectReason: output.reject_reason });
    return commit(ctx, result, "rejected", "reject");
  }
  if (output.decision === "duplicate") {
    const evidence = output.evidence_by_entry.map((entry) => ({ entryId: entry.entry_id, evidence: entry.evidence }));
    return commit(ctx, recordDuplicate(ctx.integration, ctx.unit.items, evidence, { ...record, decision: "duplicate" }), "ingested", "duplicate");
  }
  const newNames = output.concepts.filter((concept) => concept.match === "new").map((concept) => concept.name);
  const integration = { ...ctx.integration, nameSimilarities: await nameSimilarities(ctx.deps.indexCtx, newNames) };
  const result = integrateExtraction(integration, ctx.unit.items, output, {
    ...record,
    decision: output.decision,
    summary: output.item_summary,
    points: output.item_points
  });
  if (result.status === "rejected") return commit(ctx, result, "rejected", "reject");
  return commit(ctx, result, "ingested", output.decision);
}

async function submitDuplicate(ctx: Ctx, input: Extract<SubmitDecisionInput, { decision: "duplicate" }>): Promise<SubmitResult> {
  if (hasUserMarks(ctx.unit)) {
    throw new AgentToolError(
      "marked_requires_compose",
      "用户划线/笔记过的内容不能直接判重复，请抽取知识点并用 compose 提交；若全部已覆盖，在 compose.dropped 中以 covered 标注"
    );
  }
  const targets = [...new Set(input.target_entry_ids)];
  const unknown = targets.filter((id) => !loadEntry(ctx.deps.db, id));
  if (unknown.length) throw new AgentToolError("unknown_entry", `以下词条不存在或已删除：${unknown.join("、")}`, unknown);
  const badQuotes = unquoted(
    ctx.unit,
    input.evidence.map((entry) => entry.quote)
  );
  if (badQuotes.length) throw new AgentToolError("quote_not_found", `以下 evidence 的 quote 不是单元原文摘录：第 ${badQuotes.map((index) => index + 1).join("、")} 条`, badQuotes);
  const evidence = targets.map((entryId) => ({
    entryId,
    evidence: input.evidence.filter((entry) => entry.entry_id === entryId).map((entry) => ({ quote: entry.quote }))
  }));
  const result = recordDuplicate(ctx.integration, ctx.unit.items, evidence, { ...ctx.record, decision: "duplicate" });
  return commit(ctx, result, "ingested", "duplicate");
}

export async function submitDecision(deps: SubmitDeps, input: SubmitDecisionInput, client: string | null): Promise<SubmitResult> {
  const { db } = deps;
  const now = deps.now().toISOString();
  requireAgentRun(db, input.run_id);
  touchAgentRun(db, input.run_id, now);
  const unit = locateUnit(db, input.unit_key);
  const ctx: Ctx = {
    deps,
    runId: input.run_id,
    unit,
    integration: {
      db,
      runId: input.run_id,
      now,
      kbIgnore: kbIgnoreNames(db),
      nameSimilarities: new Map(),
      usedNoteIds: unit.items.flatMap((item) => item.itemNotes.map((note) => note.id))
    },
    record: {
      decision: input.decision === "compose" ? "new" : input.decision,
      route: "agent",
      valueScore: input.decision === "compose" ? input.value_score : null,
      rejectReason: null,
      reason: input.reason,
      summary: null,
      points: null,
      model: client ? `agent:${client}` : "agent",
      promptVersion: AGENT_GUIDELINES_VERSION,
      inputHash: null,
      episodeId: null,
      override: null,
      output: null
    }
  };
  switch (input.decision) {
    case "compose":
      return submitCompose(ctx, input);
    case "duplicate":
      return submitDuplicate(ctx, input);
    case "reject":
      return commit(ctx, recordRejection(ctx.integration, unit.items, { ...ctx.record, rejectReason: input.reject_reason }), "rejected", "reject");
    case "not_learning":
      return commit(ctx, recordRejection(ctx.integration, unit.items, ctx.record), "rejected", "not_learning");
  }
}
