import type { DatabaseSync } from "node:sqlite";
import type { KbEntryDetail, KbEntryPatch } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import { SUGGESTION_HEADING } from "../organize/patch.js";
import { normalizeHeading } from "../organize/normalize.js";
import { getKbEntryDetail } from "./detail.js";
import { estimateMastery } from "./mastery.js";
import { loadAliveEntry, loadMasterySignals, signalsOf } from "./queries.js";
import { reindexEntries, type KbSearchIndex } from "./search-sync.js";

export type PatchKbEntryResult = { status: "ok"; detail: KbEntryDetail } | { status: "not_found" } | { status: "category_not_found" };

/**
 * The「整理建议」section collects organize patches for `user_edited` entries and is cleared once the user saves (07 ⑥).
 * Removes it together with its nested (level ≥ 3) headings.
 */
export function stripSuggestionSection(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const target = normalizeHeading(SUGGESTION_HEADING);
  const kept: string[] = [];
  let skipLevel: number | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skipLevel !== null && level <= skipLevel) skipLevel = null;
      if (skipLevel === null && normalizeHeading(line) === target) {
        skipLevel = level;
        continue;
      }
    }
    if (skipLevel === null) kept.push(line);
  }
  if (kept.length === lines.length) return markdown;
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "\n");
}

/** Recompute and persist `mastery` for `auto` entries (after organize / reading). Entries without sources keep their value. */
export function recomputeAutoMastery(db: DatabaseSync, ids?: readonly string[]): number {
  const signals = loadMasterySignals(db);
  const rows = (
    ids
      ? db
          .prepare(
            "SELECT id, mastery FROM kb_entries WHERE deleted_at IS NULL AND COALESCE(mastery_source, 'auto') <> 'user' AND id IN (SELECT value FROM json_each(?))"
          )
          .all(JSON.stringify(ids))
      : db.prepare("SELECT id, mastery FROM kb_entries WHERE deleted_at IS NULL AND COALESCE(mastery_source, 'auto') <> 'user'").all()
  ) as { id: string; mastery: number | null }[];
  const update = db.prepare("UPDATE kb_entries SET mastery = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const next = estimateMastery(signalsOf(signals, row.id), row.mastery);
    if (next !== row.mastery) {
      update.run(next, row.id);
      changed += 1;
    }
  }
  return changed;
}

/** PATCH /v1/kb/entries/:id. Body edits set `user_edited=1, dirty=1` and never trigger organize. */
export async function patchKbEntry(
  db: DatabaseSync,
  id: string,
  patch: KbEntryPatch,
  options: { searchIndex?: KbSearchIndex; now?: Date } = {}
): Promise<PatchKbEntryResult> {
  const now = (options.now ?? new Date()).toISOString();
  const outcome = withTransaction(db, (): PatchKbEntryResult["status"] => {
    const entry = loadAliveEntry(db, id);
    if (!entry) return "not_found";
    if (patch.categoryId) {
      const exists = db.prepare("SELECT 1 FROM kb_categories WHERE id = ?").get(patch.categoryId);
      if (!exists) return "category_not_found";
    }
    if (patch.bodyMarkdown !== undefined) {
      db.prepare("UPDATE kb_entries SET body_markdown = ?, user_edited = 1, dirty = 1 WHERE id = ?").run(stripSuggestionSection(patch.bodyMarkdown), id);
    }
    if (patch.mastery !== undefined) {
      if (patch.mastery === null) {
        const auto = estimateMastery(signalsOf(loadMasterySignals(db), id), entry.mastery);
        db.prepare("UPDATE kb_entries SET mastery = ?, mastery_source = 'auto' WHERE id = ?").run(auto, id);
      } else {
        db.prepare("UPDATE kb_entries SET mastery = ?, mastery_source = 'user' WHERE id = ?").run(patch.mastery, id);
      }
    }
    if (patch.categoryId !== undefined) {
      db.prepare("UPDATE kb_entries SET category_id = ? WHERE id = ?").run(patch.categoryId, id);
    }
    if (patch.kind !== undefined) db.prepare("UPDATE kb_entries SET kind = ? WHERE id = ?").run(patch.kind, id);
    db.prepare("UPDATE kb_entries SET updated_at = ? WHERE id = ?").run(now, id);
    return "ok";
  });
  if (outcome !== "ok") return { status: outcome };
  if (patch.bodyMarkdown !== undefined) await reindexEntries(options.searchIndex, db, [id]);
  return { status: "ok", detail: getKbEntryDetail(db, id)! };
}
