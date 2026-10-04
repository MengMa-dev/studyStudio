import type { DatabaseSync } from "node:sqlite";
import { PROMPTS } from "../../ai/prompts/index.js";
import { SOURCE_KINDS, type EntryRewriteInput, type EntryRewriteOutput, type PointImportance } from "../../ai/prompts/schemas.draft.js";
import { withTransaction } from "../../db/database.js";
import { estimateTokens } from "../../search/chunk.js";
import { normalizeKind } from "../kb/queries.js";
import { callLlm, type LlmContext } from "./llm.js";
import { applyPatchOps } from "./patch.js";
import { categoryName, entryNotes, loadEntry, parseJson, type EntryRecord } from "./store.js";
import type { StoredEvidence } from "./integrate.js";

/** ⑦ Entry Rewrite (manual / stale / full) and stale detection. */

export const REWRITE_PROMPT_VERSION = PROMPTS.entry_rewrite.version;

const SOURCE_RELIABILITY: Record<string, number> = { official_doc: 0, repo: 1, community: 2, blog: 3, other: 4, ai_answer: 5 };
const IMPORTANCE_RANK: Record<PointImportance, number> = { core: 0, supporting: 1, detail: 2 };
const REWRITE_EVIDENCE_TOKENS = 16_000;

/**
 * Marks entries `stale` when a source item was deleted after the entry's last update (missing items count as deleted).
 * Non-destructive: source rows stay so a trash restore keeps working; rewrite only reads live sources.
 */
export function markStaleEntries(db: DatabaseSync): number {
  const result = db
    .prepare(
      `UPDATE kb_entries SET stale = 1 WHERE deleted_at IS NULL AND stale = 0 AND id IN (
         SELECT s.entry_id FROM kb_entry_sources s LEFT JOIN items i ON i.id = s.item_id
         WHERE s.entry_id = kb_entries.id AND (i.id IS NULL OR (i.deleted_at IS NOT NULL AND i.deleted_at > COALESCE(kb_entries.updated_at, ''))))`
    )
    .run();
  return Number(result.changes);
}

export function staleEntryIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM kb_entries WHERE deleted_at IS NULL AND stale = 1 ORDER BY updated_at").all() as Array<{ id: string }>).map(
    (row) => row.id
  );
}

type EvidenceRow = { item_id: string; evidence: string | null; source_kind: string | null; title: string | null };

/** Live evidence as knowledge points: core first, then by source reliability, cut at REWRITE_EVIDENCE_TOKENS. */
export function liveEvidence(db: DatabaseSync, entryId: string): EntryRewriteInput["evidence"] {
  const rows = db
    .prepare(
      `SELECT s.item_id, s.evidence, s.source_kind, i.title FROM kb_entry_sources s JOIN items i ON i.id = s.item_id
       WHERE s.entry_id = ? AND i.deleted_at IS NULL`
    )
    .all(entryId) as EvidenceRow[];
  const evidence: Array<Omit<EntryRewriteInput["evidence"][number], "id">> = [];
  for (const row of rows) {
    const kind = (SOURCE_KINDS as readonly string[]).includes(row.source_kind ?? "")
      ? (row.source_kind as EntryRewriteInput["evidence"][number]["source_kind"])
      : "other";
    for (const item of parseJson<StoredEvidence[]>(row.evidence, [])) {
      if (!item?.quote) continue;
      evidence.push({
        item_id: item.turnItemId ?? row.item_id,
        source_kind: kind,
        title: row.title ?? row.item_id,
        point: item.point ?? null,
        importance: item.importance ?? "supporting",
        quote: item.quote,
        question: item.question ?? null
      });
    }
  }
  evidence.sort(
    (a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] || (SOURCE_RELIABILITY[a.source_kind] ?? 9) - (SOURCE_RELIABILITY[b.source_kind] ?? 9)
  );
  const kept: EntryRewriteInput["evidence"] = [];
  let used = 0;
  for (const item of evidence) {
    used += estimateTokens(`${item.point ?? ""}${item.quote}`);
    if (used > REWRITE_EVIDENCE_TOKENS && kept.length > 0) break;
    kept.push({ id: `e${kept.length + 1}`, ...item });
  }
  return kept;
}

/** core / supporting evidence neither covered nor dropped. */
export function missingEvidence(input: EntryRewriteInput, output: EntryRewriteOutput): EntryRewriteInput["evidence"] {
  const accounted = new Set([...output.covered_ids, ...output.dropped.map((item) => item.id)]);
  return input.evidence.filter((item) => item.importance !== "detail" && !accounted.has(item.id));
}

function relatedNames(db: DatabaseSync, entryId: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT e.name FROM kb_edges g JOIN kb_entries e ON e.id = CASE WHEN g.src = ? THEN g.dst ELSE g.src END
         WHERE (g.src = ? OR g.dst = ?) AND e.deleted_at IS NULL LIMIT 20`
      )
      .all(entryId, entryId, entryId) as Array<{ name: string }>
  ).map((row) => row.name);
}

export function buildRewriteInput(db: DatabaseSync, entry: EntryRecord, trigger: EntryRewriteInput["trigger"], requirement: string | null): EntryRewriteInput {
  return {
    entry: {
      entry_id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      kind: normalizeKind(entry.kind),
      category: categoryName(db, entry.categoryId) ?? "",
      summary: entry.summary ?? "",
      body_markdown: entry.body,
      patch_count: entry.patchCount
    },
    trigger,
    evidence: liveEvidence(db, entry.id),
    entry_notes: entryNotes(db, entry.id).map((note) => note.text),
    requirement,
    related_entry_names: relatedNames(db, entry.id),
    feedback: null
  };
}

export type RewriteOutcome = { status: "rewritten" | "orphaned" | "missing"; entry: EntryRecord | null };

export async function rewriteEntry(
  db: DatabaseSync,
  llm: LlmContext,
  entryId: string,
  trigger: EntryRewriteInput["trigger"],
  requirement: string | null,
  now: string
): Promise<RewriteOutcome> {
  const entry = loadEntry(db, entryId);
  if (!entry) return { status: "missing", entry: null };
  const input = buildRewriteInput(db, entry, trigger, requirement);
  if (input.evidence.length === 0) {
    db.prepare("UPDATE kb_entries SET orphan = 1, stale = 0, updated_at = ? WHERE id = ?").run(now, entryId);
    return { status: "orphaned", entry: loadEntry(db, entryId) };
  }
  const prompt = PROMPTS.entry_rewrite;
  const call = async (payload: EntryRewriteInput) =>
    (
      await callLlm(llm, {
        stage: "entry_rewrite",
        task: prompt.task,
        schema: prompt.outputSchema(payload),
        system: prompt.system,
        prompt: prompt.buildUserPrompt(payload),
        promptVersion: prompt.version,
        input: payload
      })
    ).object;
  let object = await call(input);
  const missing = missingEvidence(input, object);
  if (missing.length) {
    const feedback = [`以下要点未写入正文，也未在 dropped 中说明理由，请补上：${missing.map((item) => `${item.id}「${item.point ?? item.quote}」`).join("；")}`];
    const retry = await call({ ...input, feedback });
    if (missingEvidence(input, retry).length < missing.length) object = retry;
  }
  withTransaction(db, () => {
    const current = loadEntry(db, entryId);
    if (!current) return;
    if (current.userEdited) {
      const applied = applyPatchOps({
        body_markdown: current.body,
        ops: [{ op: "add_section", after: "", heading: "重写建议", markdown: object.body_markdown }],
        user_edited: true,
        patch_count: current.patchCount
      });
      db.prepare("UPDATE kb_entries SET body_markdown = ?, stale = 0, orphan = 0, updated_at = ? WHERE id = ?").run(applied.body_markdown, now, entryId);
    } else {
      db.prepare(
        "UPDATE kb_entries SET body_markdown = ?, summary = ?, completeness = ?, patch_count = 0, stale = 0, orphan = 0, dirty = 0, updated_at = ? WHERE id = ?"
      ).run(object.body_markdown, object.summary, JSON.stringify(object.completeness), now, entryId);
    }
    const used = entryNotes(db, entryId).map((note) => note.id);
    const markUsed = db.prepare("UPDATE notes SET used_at = ? WHERE id = ?");
    for (const id of used) markUsed.run(now, id);
  });
  return { status: "rewritten", entry: loadEntry(db, entryId) };
}
