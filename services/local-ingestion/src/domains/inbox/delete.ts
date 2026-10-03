import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeleteImpactResponse, DeleteItemsRequest, DeleteItemsResponse } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import type { ItemRow, KbEdgeRow, KbEdgeSourceRow, KbEntryRow, KbEntrySourceRow, NoteRow, OrganizeResultRow } from "../../db/types.js";
import { hostOf, insertRule, listRules } from "../capture/rules.js";
import { insertTrashRow } from "../trash/store.js";
import { selectIn } from "./sql.js";

/** Payload of `items` / `notes` / `mixed` trash rows: everything needed to roll the delete back. */
export type ItemTrashPayload = {
  itemIds: string[];
  noteIds: string[];
  kb: {
    /** Entry rows as they were before the delete (soft-deleted, staled or orphaned). */
    entries: KbEntryRow[];
    deletedEntryIds: string[];
    sources: KbEntrySourceRow[];
    edges: KbEdgeRow[];
    edgeSources: KbEdgeSourceRow[];
    organizeResults: OrganizeResultRow[];
  };
  ruleIds: string[];
};

type KbPlan = {
  sources: KbEntrySourceRow[];
  toDelete: KbEntryRow[];
  toStale: KbEntryRow[];
  toOrphan: KbEntryRow[];
};

function activeItems(db: DatabaseSync, ids: readonly string[]): ItemRow[] {
  return selectIn<ItemRow>(db, (list) => `SELECT * FROM items WHERE deleted_at IS NULL AND id IN (${list}) ORDER BY captured_at DESC`, ids);
}

function activeNotes(db: DatabaseSync, noteIds: readonly string[], itemIds: readonly string[]): NoteRow[] {
  const explicit = selectIn<NoteRow>(db, (list) => `SELECT * FROM notes WHERE deleted_at IS NULL AND id IN (${list})`, noteIds);
  const attached = selectIn<NoteRow>(db, (list) => `SELECT * FROM notes WHERE deleted_at IS NULL AND scope = 'item' AND target_id IN (${list})`, itemIds);
  const byId = new Map<string, NoteRow>();
  for (const note of [...explicit, ...attached]) byId.set(note.id, note);
  return [...byId.values()];
}

/**
 * Entries sourced only from the deleted items are deleted; entries with other live sources go stale;
 * user-edited entries are never deleted and become orphans once no source remains.
 */
function planKb(db: DatabaseSync, itemIds: readonly string[]): KbPlan {
  const removed = new Set(itemIds);
  const sources = selectIn<KbEntrySourceRow>(db, (list) => `SELECT * FROM kb_entry_sources WHERE item_id IN (${list})`, itemIds);
  const entryIds = [...new Set(sources.map((source) => source.entry_id))];
  const entries = selectIn<KbEntryRow>(db, (list) => `SELECT * FROM kb_entries WHERE deleted_at IS NULL AND id IN (${list}) ORDER BY name`, entryIds);
  const allSources = selectIn<KbEntrySourceRow>(db, (list) => `SELECT * FROM kb_entry_sources WHERE entry_id IN (${list})`, entryIds);
  const otherItemIds = [...new Set(allSources.map((source) => source.item_id).filter((id) => !removed.has(id)))];
  const liveItems = new Set(
    selectIn<{ id: string }>(db, (list) => `SELECT id FROM items WHERE deleted_at IS NULL AND id IN (${list})`, otherItemIds).map((row) => row.id)
  );

  const plan: KbPlan = { sources, toDelete: [], toStale: [], toOrphan: [] };
  for (const entry of entries) {
    const remaining = allSources.filter((source) => source.entry_id === entry.id && liveItems.has(source.item_id)).length;
    if (remaining > 0) plan.toStale.push(entry);
    else if (entry.user_edited) plan.toOrphan.push(entry);
    else plan.toDelete.push(entry);
  }
  return plan;
}

export function deleteImpact(db: DatabaseSync, itemIds: readonly string[], noteIds: readonly string[] = []): DeleteImpactResponse {
  const items = activeItems(db, itemIds);
  const ids = items.map((item) => item.id);
  const notes = activeNotes(db, noteIds, ids);
  const plan = planKb(db, ids);
  const brief = (entry: KbEntryRow) => ({ id: entry.id, name: entry.name });
  return {
    itemCount: items.length,
    noteCount: notes.length,
    entriesToDelete: plan.toDelete.map(brief),
    entriesToStale: plan.toStale.map(brief),
    entriesToOrphan: plan.toOrphan.map(brief),
    evidenceCount: plan.sources.length
  };
}

function edgeKey(edge: { src: string; dst: string; type: string }): string {
  return JSON.stringify([edge.src, edge.dst, edge.type]);
}

function removeFromKb(db: DatabaseSync, itemIds: string[], nowIso: string): ItemTrashPayload["kb"] {
  const plan = planKb(db, itemIds);
  const deletedEntryIds = plan.toDelete.map((entry) => entry.id);

  const edgeSources = new Map<string, KbEdgeSourceRow>();
  const edges = new Map<string, KbEdgeRow>();
  const takeEdgeSources = (rows: (KbEdgeSourceRow & { rowid: number })[]) => {
    for (const { rowid, ...row } of rows) edgeSources.set(String(rowid), row);
  };
  takeEdgeSources(selectIn(db, (list) => `SELECT rowid, * FROM kb_edge_sources WHERE item_id IN (${list})`, itemIds));
  takeEdgeSources(selectIn(db, (list) => `SELECT rowid, * FROM kb_edge_sources WHERE src IN (${list})`, deletedEntryIds));
  takeEdgeSources(selectIn(db, (list) => `SELECT rowid, * FROM kb_edge_sources WHERE dst IN (${list})`, deletedEntryIds));
  for (const edge of selectIn<KbEdgeRow>(db, (list) => `SELECT * FROM kb_edges WHERE src IN (${list})`, deletedEntryIds)) edges.set(edgeKey(edge), edge);
  for (const edge of selectIn<KbEdgeRow>(db, (list) => `SELECT * FROM kb_edges WHERE dst IN (${list})`, deletedEntryIds)) edges.set(edgeKey(edge), edge);

  const organizeResults = selectIn<OrganizeResultRow>(db, (list) => `SELECT * FROM organize_results WHERE item_id IN (${list})`, itemIds);

  const deleteEdgeSource = db.prepare("DELETE FROM kb_edge_sources WHERE rowid = ?");
  for (const rowid of edgeSources.keys()) deleteEdgeSource.run(Number(rowid));

  // Edges backed only by the removed item sources lose their last evidence and go too.
  const touched = new Map<string, { src: string; dst: string; type: string }>();
  for (const source of edgeSources.values()) touched.set(edgeKey(source), source);
  const countSources = db.prepare("SELECT COUNT(*) AS n FROM kb_edge_sources WHERE src = ? AND dst = ? AND type = ?");
  const getEdge = db.prepare("SELECT * FROM kb_edges WHERE src = ? AND dst = ? AND type = ?");
  for (const key of touched.values()) {
    if (Number((countSources.get(key.src, key.dst, key.type) as { n: number }).n) > 0) continue;
    const edge = getEdge.get(key.src, key.dst, key.type) as KbEdgeRow | undefined;
    if (edge) edges.set(edgeKey(edge), edge);
  }
  const deleteEdge = db.prepare("DELETE FROM kb_edges WHERE src = ? AND dst = ? AND type = ?");
  for (const edge of edges.values()) deleteEdge.run(edge.src, edge.dst, edge.type);

  const deleteSource = db.prepare("DELETE FROM kb_entry_sources WHERE entry_id = ? AND item_id = ?");
  for (const source of plan.sources) deleteSource.run(source.entry_id, source.item_id);

  const softDelete = db.prepare("UPDATE kb_entries SET deleted_at = ? WHERE id = ?");
  for (const entry of plan.toDelete) softDelete.run(nowIso, entry.id);
  const stale = db.prepare("UPDATE kb_entries SET stale = 1 WHERE id = ?");
  for (const entry of plan.toStale) stale.run(entry.id);
  const orphan = db.prepare("UPDATE kb_entries SET orphan = 1 WHERE id = ?");
  for (const entry of plan.toOrphan) orphan.run(entry.id);

  const deleteResult = db.prepare("DELETE FROM organize_results WHERE item_id = ?");
  for (const result of organizeResults) deleteResult.run(result.item_id);

  return {
    entries: [...plan.toDelete, ...plan.toStale, ...plan.toOrphan],
    deletedEntryIds,
    sources: plan.sources,
    edges: [...edges.values()],
    edgeSources: [...edgeSources.values()],
    organizeResults
  };
}

/** "Stop collecting this page / site": only webpages carry a meaningful URL. */
function addRules(db: DatabaseSync, items: ItemRow[], kind: DeleteItemsRequest["rule"], nowIso: string): string[] {
  if (kind === "none") return [];
  const existing = new Set(listRules(db).map((rule) => `${rule.kind}\n${rule.value}`));
  const created: string[] = [];
  for (const item of items) {
    if (item.type !== "webpage") continue;
    const url = item.canonical_url ?? item.url;
    if (!url) continue;
    const value = kind === "domain" ? hostOf(url) : url;
    if (!value || existing.has(`${kind}\n${value}`)) continue;
    existing.add(`${kind}\n${value}`);
    const id = randomUUID();
    insertRule(db, { id, kind, value, note: "删除时添加", createdAt: nowIso });
    created.push(id);
  }
  return created;
}

export class NothingToDeleteError extends Error {
  constructor() {
    super("nothing to delete");
    this.name = "NothingToDeleteError";
  }
}

/** Moves items (with their item notes) and selected notes to the trash in one transaction. */
export function deleteItems(db: DatabaseSync, request: DeleteItemsRequest, now = new Date()): DeleteItemsResponse {
  return withTransaction(db, () => {
    const nowIso = now.toISOString();
    const items = activeItems(db, request.ids);
    const itemIds = items.map((item) => item.id);
    const notes = activeNotes(db, request.noteIds, itemIds);
    if (!items.length && !notes.length) throw new NothingToDeleteError();

    const kb: ItemTrashPayload["kb"] = request.removeFromKb
      ? removeFromKb(db, itemIds, nowIso)
      : { entries: [], deletedEntryIds: [], sources: [], edges: [], edgeSources: [], organizeResults: [] };
    const ruleIds = addRules(db, items, request.rule, nowIso);

    const softDeleteItem = db.prepare("UPDATE items SET deleted_at = ? WHERE id = ?");
    for (const id of itemIds) softDeleteItem.run(nowIso, id);
    const softDeleteNote = db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?");
    for (const note of notes) softDeleteNote.run(nowIso, note.id);

    const explicitNotes = notes.filter((note) => request.noteIds.includes(note.id) && !(note.scope === "item" && itemIds.includes(note.target_id ?? "")));
    const kind = items.length && explicitNotes.length ? "mixed" : items.length ? "items" : "notes";
    const first = items[0];
    const title = first ? (first.title ?? first.url ?? "已删除条目") : (notes[0]?.text ?? "已删除备注");
    const count = items.length + explicitNotes.length;
    const payload: ItemTrashPayload = { itemIds, noteIds: notes.map((note) => note.id), kb, ruleIds };
    const record = insertTrashRow(db, {
      kind,
      targets: { itemIds, noteIds: payload.noteIds },
      meta: {
        title: count > 1 ? `${title} 等 ${count} 项` : title,
        site: first?.site ?? null,
        itemType: first?.type ?? null,
        removeFromKb: request.removeFromKb,
        removedEntryCount: kb.deletedEntryIds.length
      },
      payload,
      now
    });
    return { trashId: record.id, deletedItemCount: items.length, deletedNoteCount: notes.length };
  });
}
