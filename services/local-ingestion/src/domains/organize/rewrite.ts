import type { DatabaseSync } from "node:sqlite";
import { PROMPTS } from "../../ai/prompts/index.js";
import { SOURCE_KINDS, type EntryRewriteInput } from "../../ai/prompts/schemas.draft.js";
import { withTransaction } from "../../db/database.js";
import { normalizeKind } from "../kb/queries.js";
import { callLlm, type LlmContext } from "./llm.js";
import { applyPatchOps } from "./patch.js";
import { categoryName, entryNotes, loadEntry, parseJson, type EntryRecord } from "./store.js";
import type { StoredEvidence } from "./integrate.js";

/** ⑦ Entry Rewrite (manual / stale / full) and stale detection. */

export const REWRITE_PROMPT_VERSION = PROMPTS.entry_rewrite.version;

const SOURCE_RELIABILITY: Record<string, number> = { official_doc: 0, repo: 1, community: 2, blog: 3, other: 4, ai_answer: 5 };
const MAX_EVIDENCE = 60;

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

export function liveEvidence(db: DatabaseSync, entryId: string): EntryRewriteInput["evidence"] {
  const rows = db
    .prepare(
      `SELECT s.item_id, s.evidence, s.source_kind, i.title FROM kb_entry_sources s JOIN items i ON i.id = s.item_id
       WHERE s.entry_id = ? AND i.deleted_at IS NULL`
    )
    .all(entryId) as EvidenceRow[];
  const evidence: EntryRewriteInput["evidence"] = [];
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
        quote: item.quote,
        question: item.question ?? null
      });
    }
  }
  return evidence.sort((a, b) => (SOURCE_RELIABILITY[a.source_kind] ?? 9) - (SOURCE_RELIABILITY[b.source_kind] ?? 9)).slice(0, MAX_EVIDENCE);
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
    related_entry_names: relatedNames(db, entry.id)
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
  const { object } = await callLlm(llm, {
    stage: "entry_rewrite",
    task: "entry_rewrite",
    schema: prompt.outputSchema(input),
    system: prompt.system,
    prompt: prompt.buildUserPrompt(input),
    promptVersion: prompt.version,
    input
  });
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
