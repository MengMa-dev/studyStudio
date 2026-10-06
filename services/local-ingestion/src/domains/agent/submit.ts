import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  appendSections,
  attachSectionSources,
  kbRelationTypeSchema,
  LEGACY_KIND_NAMES,
  parseSections,
  sanitizeHeading,
  SEED_KINDS,
  sourceKindOf,
  type OrganizeRunEntryChange,
  type OrganizeRunStats
} from "@study-studio/shared";
import { z } from "zod";
import { withTransaction } from "../../db/database.js";
import { writeResults, type ResultRecord } from "../organize/integrate.js";
import { indexEntryBody, indexEntrySummary, type IndexContext } from "../organize/kb-index.js";
import type { WorkUnit } from "../organize/process.js";
import { getRunRow, setJob, toRunSummary, updateRun } from "../organize/run-store.js";
import { rejectReasonSchema } from "../organize/schemas.js";
import { normalizeEntryName } from "../organize/normalize.js";
import { resolveKind } from "../organize/kinds.js";
import { findEntryByName, fuzzyNotesNear, kbIgnoreNames, listAliveEntries, loadEntry, parseJson, type EntryRecord } from "../organize/store.js";
import { TraceRecorder } from "../organize/trace.js";
import { AgentToolError } from "./errors.js";
import { AGENT_GUIDELINES_VERSION } from "./guidelines.js";
import { agentUnitState, requireAgentRun, touchAgentRun, updateAgentUnitState } from "./session.js";
import { findUnit } from "./units.js";

/** Agent write tools (17): write_entry / attach_source / add_relation / finish_unit. Sections carry server-generated markers. */

export type WriteDeps = { db: DatabaseSync; indexCtx: IndexContext | null; now: () => Date };

const unitRef = { run_id: z.string().min(1), unit_key: z.string().min(1) };

const SINGLE_LINE = /^[^\r\n]*$/;
const HEADING_MAX = 120;
const SECTION_MARKDOWN_MAX = 20_000;

export const writeEntrySchema = z.object({
  ...unitRef,
  entry_id: z.string().min(1).optional(),
  new: z
    .object({
      name: z.string().trim().min(1).max(HEADING_MAX).regex(SINGLE_LINE, "name 不能换行"),
      aliases: z.array(z.string()).optional(),
      kind: z.string().min(1),
      category: z.string().nullable().optional(),
      summary: z.string()
    })
    .optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(HEADING_MAX).regex(SINGLE_LINE, "heading 不能换行"),
        markdown: z.string().trim().min(1).max(SECTION_MARKDOWN_MAX),
        source_item_ids: z.array(z.string().min(1)).min(1)
      })
    )
    .min(1)
});

export const attachSourceSchema = z.object({ ...unitRef, entry_id: z.string().min(1), section_id: z.string().min(1), item_ids: z.array(z.string().min(1)).min(1) });

export const addRelationSchema = z.object({
  ...unitRef,
  /** Entry id or name / alias. */
  from: z.string().min(1),
  to: z.string().min(1),
  type: kbRelationTypeSchema,
  description: z.string().optional()
});

export const finishUnitSchema = z.object({
  ...unitRef,
  status: z.enum(["organized", "rejected", "not_learning", "skipped"]),
  reason: z.string(),
  reject_reason: rejectReasonSchema.optional()
});

export type WriteEntryInput = z.infer<typeof writeEntrySchema>;
export type AttachSourceInput = z.infer<typeof attachSourceSchema>;
export type AddRelationInput = z.infer<typeof addRelationSchema>;
export type FinishUnitInput = z.infer<typeof finishUnitSchema>;

type Ctx = { deps: WriteDeps; runId: string; key: string; unit: WorkUnit; model: string; now: string };

type SectionEvidence = { section_id: string; heading: string; quote: string };

function locateUnit(db: DatabaseSync, key: string): WorkUnit {
  const unit = findUnit(db, key);
  if (unit) return unit;
  const row = db.prepare("SELECT organize_status FROM items WHERE id = ? AND deleted_at IS NULL").get(key) as { organize_status: string } | undefined;
  if (row) throw new AgentToolError("already_organized", "该单元已整理过，请用 list_inbox 取下一个单元");
  throw new AgentToolError("unit_not_found", "单元不存在，请重新调用 list_inbox 获取 unit_key");
}

function begin(deps: WriteDeps, runId: string, key: string): Ctx {
  const now = deps.now().toISOString();
  const run = requireAgentRun(deps.db, runId);
  touchAgentRun(deps.db, runId, now);
  return { deps, runId, key, unit: locateUnit(deps.db, key), model: run.model ?? "agent", now };
}

function trace(ctx: Ctx, tool: string, input: unknown, output: unknown): void {
  new TraceRecorder(ctx.deps.db, ctx.runId).record("integration", "agent_submit", { tool, ...(input as object) }, output, {
    model: ctx.model,
    scope: { itemIds: ctx.unit.items.map((item) => item.id) }
  });
}

function requireEntry(db: DatabaseSync, id: string): EntryRecord {
  const entry = loadEntry(db, id);
  if (!entry) throw new AgentToolError("entry_not_found", `词条不存在或已删除：${id}`);
  return entry;
}

function requireUnitItems(ctx: Ctx, ids: string[]): void {
  const known = new Set(ctx.unit.items.map((item) => item.id));
  const unknown = [...new Set(ids)].filter((id) => !known.has(id));
  if (unknown.length) throw new AgentToolError("invalid_source", `以下条目不属于该单元：${unknown.join("、")}；可用：${[...known].join("、")}`, unknown);
}

function resolveCategory(db: DatabaseSync, name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const rows = db.prepare("SELECT id, name FROM kb_categories").all() as Array<{ id: string; name: string | null }>;
  const hit = rows.find((row) => row.name && normalizeEntryName(row.name) === normalizeEntryName(trimmed));
  if (hit) return hit.id;
  const id = randomUUID();
  const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM kb_categories").get() as { next: number }).next;
  db.prepare("INSERT INTO kb_categories(id, name, description, sort) VALUES (?, ?, NULL, ?)").run(id, trimmed, sort);
  return id;
}

function isKnownKind(kind: string): boolean {
  const name = kind.trim();
  return Object.hasOwn(LEGACY_KIND_NAMES, name.toLowerCase()) || SEED_KINDS.some((seed) => normalizeEntryName(seed) === normalizeEntryName(name));
}

/** Upserts entry-level sources, merging section evidence by section id. */
function addSectionSources(ctx: Ctx, entryId: string, sections: Array<{ id: string; heading: string; itemIds: string[] }>): void {
  const { db } = ctx.deps;
  const byId = new Map(ctx.unit.items.map((item) => [item.id, item]));
  const select = db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = ? AND item_id = ?");
  const upsert = db.prepare(
    `INSERT INTO kb_entry_sources(entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entry_id, item_id) DO UPDATE SET evidence = excluded.evidence, source_kind = excluded.source_kind, added_at = excluded.added_at`
  );
  const itemIds = [...new Set(sections.flatMap((section) => section.itemIds))];
  for (const itemId of itemIds) {
    const item = byId.get(itemId)!;
    const row = select.get(entryId, itemId) as { evidence: string | null } | undefined;
    const evidence = parseJson<Array<Partial<SectionEvidence>>>(row?.evidence, []);
    for (const section of sections.filter((candidate) => candidate.itemIds.includes(itemId))) {
      if (!evidence.some((existing) => existing.section_id === section.id)) evidence.push({ section_id: section.id, heading: section.heading, quote: section.heading });
    }
    upsert.run(entryId, itemId, JSON.stringify(evidence), sourceKindOf(item.type, item.url), ctx.now);
  }
}

function nameConflict(db: DatabaseSync, names: string[]): EntryRecord | undefined {
  const entries = listAliveEntries(db);
  for (const name of names) {
    const hit = findEntryByName(entries, name);
    if (hit) return hit;
  }
  return undefined;
}

async function reindex(deps: WriteDeps, entryId: string, summary: boolean): Promise<void> {
  if (!deps.indexCtx) return;
  const entry = loadEntry(deps.db, entryId);
  if (!entry) return;
  if (summary) await indexEntrySummary(deps.indexCtx, entry).catch(() => undefined);
  await indexEntryBody(deps.indexCtx, entry).catch(() => undefined);
}

export async function writeEntry(deps: WriteDeps, input: WriteEntryInput): Promise<Record<string, unknown>> {
  if (Boolean(input.entry_id) === Boolean(input.new)) throw new AgentToolError("invalid_input", "entry_id（补充已有词条）与 new（新建词条）必须且只能填一个");
  const ctx = begin(deps, input.run_id, input.unit_key);
  const { db } = deps;
  requireUnitItems(
    ctx,
    input.sections.flatMap((section) => section.source_item_ids)
  );
  const added = input.sections.map((section) => ({
    heading: sanitizeHeading(section.heading.replace(/^#+\s*/, "")) || "未命名",
    markdown: section.markdown,
    sourceItemIds: section.source_item_ids
  }));

  const out = withTransaction(db, () => {
    let entryId: string;
    let ids: string[];
    if (input.new) {
      const spec = input.new;
      if (!isKnownKind(spec.kind)) throw new AgentToolError("invalid_kind", `kind 不在词表内，可选：${SEED_KINDS.join("、")}`, [...SEED_KINDS]);
      const aliases = [...new Set((spec.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];
      const ignored = new Set(kbIgnoreNames(db).map(normalizeEntryName));
      const ignoredName = [spec.name, ...aliases].find((name) => ignored.has(normalizeEntryName(name)));
      if (ignoredName) throw new AgentToolError("name_ignored", `「${ignoredName}」在忽略名单中（用户删除过该词条），不得新建；该部分内容不入库`, { name: ignoredName });
      const conflict = nameConflict(db, [spec.name, ...aliases]);
      if (conflict) {
        throw new AgentToolError("name_exists", `已有同名词条「${conflict.name}」，请改为补充该词条（entry_id: ${conflict.id}）`, { entry_id: conflict.id, name: conflict.name });
      }
      const written = appendSections("", added);
      ids = written.ids;
      entryId = randomUUID();
      db.prepare(
        `INSERT INTO kb_entries(id, name, category_id, kind, aliases, summary, body_markdown, completeness, mastery, mastery_source, user_edited, stale, orphan, patch_count, dirty, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'auto', 0, 0, 0, 0, 0, ?)`
      ).run(entryId, spec.name.trim(), resolveCategory(db, spec.category), resolveKind(spec.kind), JSON.stringify(aliases), spec.summary.trim(), written.body, ctx.now);
    } else {
      const entry = requireEntry(db, input.entry_id!);
      const written = appendSections(entry.body, added);
      ids = written.ids;
      entryId = entry.id;
      db.prepare("UPDATE kb_entries SET body_markdown = ?, patch_count = ?, updated_at = ? WHERE id = ?").run(written.body, entry.patchCount + 1, ctx.now, entryId);
    }
    addSectionSources(
      ctx,
      entryId,
      added.map((section, index) => ({ id: ids[index]!, heading: section.heading, itemIds: section.sourceItemIds }))
    );
    updateAgentUnitState(db, ctx.runId, ctx.key, (state) => {
      const list = input.new ? state.created : state.written;
      if (!list.includes(entryId)) list.push(entryId);
    });
    const entry = loadEntry(db, entryId)!;
    return {
      entry_id: entryId,
      name: entry.name,
      created: Boolean(input.new),
      sections: ids.map((id, index) => ({ section_id: id, heading: added[index]!.heading })),
      patch_count: entry.patchCount
    };
  });
  trace(ctx, "write_entry", input, out);
  await reindex(deps, out.entry_id, Boolean(input.new));
  return out;
}

export function attachSource(deps: WriteDeps, input: AttachSourceInput): Record<string, unknown> {
  const ctx = begin(deps, input.run_id, input.unit_key);
  const { db } = deps;
  requireUnitItems(ctx, input.item_ids);
  const out = withTransaction(db, () => {
    const entry = requireEntry(db, input.entry_id);
    const body = attachSectionSources(entry.body, input.section_id, input.item_ids);
    if (body === null) {
      const available = parseSections(entry.body).flatMap((section) => (section.id ? [section.id] : []));
      throw new AgentToolError("section_not_found", `词条「${entry.name}」没有章节 ${input.section_id}，请用 get_entry 查看 sections`, { available });
    }
    db.prepare("UPDATE kb_entries SET body_markdown = ?, updated_at = ? WHERE id = ?").run(body, ctx.now, entry.id);
    const heading = parseSections(body).find((section) => section.id === input.section_id)?.heading ?? "";
    addSectionSources(ctx, entry.id, [{ id: input.section_id, heading, itemIds: input.item_ids }]);
    updateAgentUnitState(db, ctx.runId, ctx.key, (state) => {
      if (!state.attached.includes(entry.id)) state.attached.push(entry.id);
    });
    return { entry_id: entry.id, section_id: input.section_id, source_item_ids: parseSections(body).find((section) => section.id === input.section_id)!.sourceItemIds };
  });
  trace(ctx, "attach_source", input, out);
  return out;
}

function resolveEntryRef(db: DatabaseSync, ref: string): EntryRecord {
  const entry = loadEntry(db, ref) ?? findEntryByName(listAliveEntries(db), ref);
  if (!entry) throw new AgentToolError("entry_not_found", `找不到词条：${ref}（填 entry_id 或词条名 / 别名）`);
  return entry;
}

export function addRelation(deps: WriteDeps, input: AddRelationInput): Record<string, unknown> {
  const ctx = begin(deps, input.run_id, input.unit_key);
  const { db } = deps;
  const from = resolveEntryRef(db, input.from);
  const to = resolveEntryRef(db, input.to);
  if (from.id === to.id) throw new AgentToolError("invalid_input", "关系两端不能是同一个词条");
  const itemId = ctx.unit.items[0]!.id;
  const out = withTransaction(db, () => {
    const created = Number(db.prepare("INSERT OR IGNORE INTO kb_edges(src, dst, type) VALUES (?, ?, ?)").run(from.id, to.id, input.type).changes) > 0;
    db.prepare("DELETE FROM kb_edge_sources WHERE src = ? AND dst = ? AND type = ? AND item_id = ?").run(from.id, to.id, input.type, itemId);
    db.prepare("INSERT INTO kb_edge_sources(src, dst, type, item_id, description) VALUES (?, ?, ?, ?, ?)").run(from.id, to.id, input.type, itemId, input.description?.trim() || null);
    if (created) updateAgentUnitState(db, ctx.runId, ctx.key, (state) => void (state.edges += 1));
    return { from_entry_id: from.id, to_entry_id: to.id, type: input.type, created };
  });
  trace(ctx, "add_relation", input, out);
  return out;
}

function bumpStats(db: DatabaseSync, runId: string, update: (stats: OrganizeRunStats) => void): void {
  const row = getRunRow(db, runId);
  if (!row) return;
  const stats = toRunSummary(row).stats;
  update(stats);
  updateRun(db, runId, { stats });
}

export function finishUnit(deps: WriteDeps, input: FinishUnitInput): Record<string, unknown> {
  const ctx = begin(deps, input.run_id, input.unit_key);
  const { db } = deps;
  const items = ctx.unit.items;
  const state = agentUnitState(db, ctx.runId, ctx.key);
  const alive = (ids: string[]) => ids.filter((id) => loadEntry(db, id));
  const created = alive(state.created);
  const written = alive(state.written).filter((id) => !created.includes(id));
  const attached = alive(state.attached).filter((id) => !created.includes(id) && !written.includes(id));
  const changes: OrganizeRunEntryChange[] = [
    ...created.map((entryId) => ({ entryId, change: "created" as const })),
    ...written.map((entryId) => ({ entryId, change: "supplemented" as const })),
    ...attached.map((entryId) => ({ entryId, change: "duplicate" as const }))
  ].map((change) => ({ ...change, name: loadEntry(db, change.entryId)!.name }));
  if (changes.length && input.status !== "organized") {
    throw new AgentToolError("unit_has_writes", "该单元已写入词条（write_entry / attach_source），只能以 organized 结束", {
      entry_ids: changes.map((change) => change.entryId)
    });
  }

  if (input.status === "skipped") {
    for (const item of items) setJob(db, ctx.runId, "item", item.id, "skipped");
    const out = { status: "skipped" };
    trace(ctx, "finish_unit", input, out);
    return out;
  }

  let decision: ResultRecord["decision"];
  if (input.status === "organized") {
    if (changes.length === 0) throw new AgentToolError("nothing_written", "该单元还没有写入任何词条；先 write_entry / attach_source，不入库请用 rejected / not_learning");
    decision = created.length ? "new" : written.length ? "supplement" : "duplicate";
  } else {
    decision = input.status === "rejected" ? "reject" : "not_learning";
  }
  const ingested = input.status === "organized";
  const record: ResultRecord = {
    decision,
    route: "agent",
    valueScore: null,
    rejectReason: input.status === "rejected" ? (input.reject_reason ?? "low_information") : null,
    reason: input.reason,
    summary: null,
    points: null,
    model: ctx.model,
    promptVersion: AGENT_GUIDELINES_VERSION,
    inputHash: null,
    episodeId: null,
    override: null,
    output: ingested ? { entry_changes: changes, edges_created: state.edges } : null
  };
  withTransaction(db, () => {
    writeResults(db, items, record, ctx.runId, ctx.now, ingested ? changes.map((change) => change.entryId) : []);
    const markUsed = db.prepare("UPDATE notes SET used_at = ? WHERE id = ?");
    const fuzzy = fuzzyNotesNear(db, items[0]!.capturedAt);
    for (const note of [...items.flatMap((item) => item.itemNotes), ...fuzzy]) markUsed.run(ctx.now, note.id);
    for (const item of items) setJob(db, ctx.runId, "item", item.id, ingested ? "ingested" : "rejected");
  });
  bumpStats(db, ctx.runId, (stats) => {
    stats.items.total += items.length;
    if (ingested) stats.items.ingested += items.length;
    else stats.items.rejected += items.length;
    stats.decisions[decision === "not_learning" ? "notLearning" : decision] += 1;
    if (ingested) {
      stats.kb.entriesCreated += created.length;
      stats.kb.entriesSupplemented += written.length;
      stats.kb.relationsCreated += state.edges;
    }
  });
  const out = {
    status: input.status,
    decision,
    entry_changes: changes.map((change) => ({ entry_id: change.entryId, name: change.name, change: change.change })),
    edges_created: state.edges
  };
  trace(ctx, "finish_unit", input, out);
  return out;
}
