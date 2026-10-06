import type { DatabaseSync } from "node:sqlite";
import { parseSections, serializeSections } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import type { ItemRow } from "../../db/types.js";
import { cleanupOrphanBlobs } from "../data/cleanup.js";
import type { ItemTrashPayload } from "../inbox/delete.js";
import { VERBATIM_MIN_RATIO, verbatimRatio } from "../organize/verify.js";
import { selectIn } from "../inbox/sql.js";
import { TrashConflictError, type TrashHandler, type TrashRecord } from "./registry.js";

function payloadOf(record: TrashRecord): ItemTrashPayload {
  const payload = (record.payload ?? {}) as Partial<ItemTrashPayload>;
  const kb = (payload.kb ?? {}) as Partial<ItemTrashPayload["kb"]>;
  return {
    itemIds: payload.itemIds ?? record.targets.itemIds,
    noteIds: payload.noteIds ?? record.targets.noteIds,
    kb: {
      entries: kb.entries ?? [],
      deletedEntryIds: kb.deletedEntryIds ?? [],
      sources: kb.sources ?? [],
      edges: kb.edges ?? [],
      edgeSources: kb.edgeSources ?? [],
      organizeResults: kb.organizeResults ?? [],
      bodies: kb.bodies ?? [],
      noteAnchors: kb.noteAnchors ?? []
    },
    ruleIds: payload.ruleIds ?? []
  };
}

function insertRow(db: DatabaseSync, table: string, row: object, conflict: "IGNORE" | "REPLACE" = "IGNORE"): void {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const columns = entries.map(([key]) => key);
  db.prepare(`INSERT OR ${conflict} INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...entries.map(([, value]) => value as string | number | null)
  );
}

/**
 * Puts back sections removed by the delete cascade. Untouched entries get the pre-delete body verbatim; entries edited
 * since get the missing sections appended (unless a marked section already contains their text) and the items re-added to surviving sections.
 */
export function mergeRestoredSections(current: string, before: string, itemIds: readonly string[]): string {
  const sections = parseSections(current);
  const byId = new Map(sections.flatMap((section) => (section.id ? [[section.id, section] as const] : [])));
  const restored = new Set(itemIds);
  for (const section of parseSections(before)) {
    const back = section.sourceItemIds.filter((id) => restored.has(id));
    if (!section.id || back.length === 0) continue;
    const existing =
      byId.get(section.id) ?? sections.find((candidate) => candidate.id !== null && verbatimRatio(section.markdown, candidate.markdown) >= VERBATIM_MIN_RATIO);
    if (existing) existing.sourceItemIds = [...new Set([...existing.sourceItemIds, ...back])];
    else sections.push(section);
  }
  return serializeSections(sections);
}

function restoreBodies(db: DatabaseSync, kb: ItemTrashPayload["kb"], itemIds: readonly string[]): void {
  const snapshots = new Map(kb.entries.map((entry) => [entry.id, entry]));
  const select = db.prepare("SELECT body_markdown FROM kb_entries WHERE id = ?");
  const update = db.prepare("UPDATE kb_entries SET body_markdown = ?, updated_at = ? WHERE id = ?");
  for (const { entryId, after } of kb.bodies ?? []) {
    const snapshot = snapshots.get(entryId);
    const row = select.get(entryId) as { body_markdown: string | null } | undefined;
    if (!snapshot || !row) continue;
    const before = snapshot.body_markdown ?? "";
    const current = row.body_markdown ?? "";
    if (current === after) update.run(before, snapshot.updated_at, entryId);
    else update.run(mergeRestoredSections(current, before, itemIds), new Date().toISOString(), entryId);
  }
  const reanchor = db.prepare("UPDATE notes SET anchor = ? WHERE id = ? AND anchor IS NULL");
  for (const note of kb.noteAnchors ?? []) reanchor.run(note.anchor, note.id);
}

function restoreItems(db: DatabaseSync, record: TrashRecord): { restoredItemCount: number; restoredNoteCount: number } {
  const payload = payloadOf(record);
  return withTransaction(db, () => {
    const items = selectIn<ItemRow>(db, (list) => `SELECT * FROM items WHERE id IN (${list})`, payload.itemIds);
    for (const item of items) {
      if (item.type !== "webpage" || !item.canonical_url || item.deleted_at === null) continue;
      const clash = db
        .prepare("SELECT id FROM items WHERE type = 'webpage' AND canonical_url = ? AND deleted_at IS NULL AND id <> ?")
        .get(item.canonical_url, item.id);
      if (clash) throw new TrashConflictError(`page was collected again: ${item.canonical_url}`);
    }

    const restoreItem = db.prepare("UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL");
    let restoredItemCount = 0;
    for (const item of items) restoredItemCount += Number(restoreItem.run(item.id).changes);
    const restoreNote = db.prepare("UPDATE notes SET deleted_at = NULL WHERE id = ?");
    let restoredNoteCount = 0;
    for (const id of payload.noteIds) restoredNoteCount += Number(restoreNote.run(id).changes);

    const { kb } = payload;
    const restoreEntry = db.prepare("UPDATE kb_entries SET deleted_at = ?, stale = ?, orphan = ? WHERE id = ?");
    for (const entry of kb.entries) restoreEntry.run(entry.deleted_at, entry.stale, entry.orphan, entry.id);
    for (const source of kb.sources) insertRow(db, "kb_entry_sources", source);
    for (const edge of kb.edges) insertRow(db, "kb_edges", edge);
    for (const source of kb.edgeSources) insertRow(db, "kb_edge_sources", source);
    for (const result of kb.organizeResults) insertRow(db, "organize_results", result);
    restoreBodies(db, kb, payload.itemIds);

    const deleteRule = db.prepare("DELETE FROM rules WHERE id = ?");
    for (const id of payload.ruleIds) deleteRule.run(id);
    return { restoredItemCount, restoredNoteCount };
  });
}

/** Physically deletes items, their children and notes; entries soft-deleted by this trash row go too. */
export function purgeItemRows(db: DatabaseSync, itemIds: readonly string[]): void {
  const statements = [
    "DELETE FROM item_contents WHERE item_id IN",
    "DELETE FROM reading_sessions WHERE item_id IN",
    "DELETE FROM item_exposure WHERE item_id IN",
    "DELETE FROM assets WHERE item_id IN",
    "DELETE FROM tags WHERE item_id IN",
    "DELETE FROM episode_items WHERE item_id IN",
    "DELETE FROM organize_results WHERE item_id IN",
    "DELETE FROM kb_entry_sources WHERE item_id IN",
    "DELETE FROM kb_edge_sources WHERE item_id IN",
    "DELETE FROM events WHERE item_id IN",
    "DELETE FROM notes WHERE scope = 'item' AND target_id IN",
    "DELETE FROM items WHERE deleted_at IS NOT NULL AND id IN"
  ];
  for (const sql of statements) selectIn(db, (list) => `${sql} (${list}) RETURNING 1`, itemIds);
}

/** Purges an `items` / `notes` / `mixed` trash row's entities; blob cleanup is left to the caller. */
export function purgeItemTrash(db: DatabaseSync, record: TrashRecord): void {
  const payload = payloadOf(record);
  withTransaction(db, () => {
    purgeItemRows(db, payload.itemIds);
    selectIn(db, (list) => `DELETE FROM notes WHERE deleted_at IS NOT NULL AND id IN (${list}) RETURNING 1`, payload.noteIds);
    const deletedEntries = selectIn<{ id: string }>(
      db,
      (list) => `SELECT id FROM kb_entries WHERE deleted_at IS NOT NULL AND id IN (${list})`,
      payload.kb.deletedEntryIds
    ).map((row) => row.id);
    selectIn(db, (list) => `DELETE FROM notes WHERE scope = 'entry' AND target_id IN (${list}) RETURNING 1`, deletedEntries);
    selectIn(db, (list) => `DELETE FROM kb_entry_sources WHERE entry_id IN (${list}) RETURNING 1`, deletedEntries);
    selectIn(db, (list) => `DELETE FROM kb_entries WHERE id IN (${list}) RETURNING 1`, deletedEntries);
  });
}

export const ITEM_TRASH_KINDS = new Set(["items", "notes", "mixed"]);

export const itemTrashHandler: TrashHandler = {
  restore: (ctx, record) => restoreItems(ctx.db, record),
  purge: (ctx, record) => {
    purgeItemTrash(ctx.db, record);
    if (ctx.dataDir) cleanupOrphanBlobs(ctx.db, ctx.dataDir);
  }
};
