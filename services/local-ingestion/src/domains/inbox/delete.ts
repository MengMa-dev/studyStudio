import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  parseSections,
  removeSectionSource,
  serializeSections,
  stripSectionMarkers,
  type DeleteImpactResponse,
  type DeleteItemsRequest,
  type DeleteItemsResponse
} from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import type { ItemRow, KbEdgeRow, KbEdgeSourceRow, KbEntryRow, KbEntrySourceRow, NoteRow, OrganizeResultRow } from "../../db/types.js";
import { hostOf, insertRule, listRules } from "../capture/rules.js";
import { reindexEntries, removeEntriesFromIndex, type KbSearchIndex } from "../kb/search-sync.js";
import { insertTrashRow } from "../trash/store.js";
import { selectIn } from "./sql.js";

/** Payload of `items` / `notes` / `mixed` trash rows: everything needed to roll the delete back. */
export type ItemTrashPayload = {
  itemIds: string[];
  noteIds: string[];
  kb: {
    /** Entry rows as they were before the delete (soft-deleted, updated or orphaned); `body_markdown` is the pre-delete body. */
    entries: KbEntryRow[];
    deletedEntryIds: string[];
    sources: KbEntrySourceRow[];
    edges: KbEdgeRow[];
    edgeSources: KbEdgeSourceRow[];
    organizeResults: OrganizeResultRow[];
    /** Bodies written by the section cascade, so restore can tell whether the entry changed since. */
    bodies?: Array<{ entryId: string; after: string }>;
    /** Section notes whose anchor was cleared because their section was removed. */
    noteAnchors?: Array<{ id: string; anchor: string }>;
  };
  ruleIds: string[];
};

type KbPlan = {
  sources: KbEntrySourceRow[];
  toDelete: KbEntryRow[];
  /** Entries that keep living with their remaining sections (reported as `entriesToStale` for API compatibility). */
  toUpdate: KbEntryRow[];
  toOrphan: KbEntryRow[];
  /** Kept entries whose body loses sections or section sources. */
  bodies: Map<string, { body: string; removedSectionIds: string[] }>;
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

/** Drops the items from section markers: sections only from them go, shared sections lose them (17). */
function cascadeSections(body: string, itemIds: readonly string[]): { body: string; removedSectionIds: string[]; changed: boolean } {
  const original = serializeSections(parseSections(body));
  let next = original;
  const removedSectionIds: string[] = [];
  for (const id of itemIds) {
    const result = removeSectionSource(next, id);
    next = result.body;
    removedSectionIds.push(...result.removedSectionIds);
  }
  return { body: next, removedSectionIds, changed: next !== original };
}

/**
 * Entries sourced only from the deleted items, or emptied by the section cascade, are deleted; entries with other
 * live sources keep their remaining sections; user-edited entries are never deleted and become orphans once no source remains.
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

  const plan: KbPlan = { sources, toDelete: [], toUpdate: [], toOrphan: [], bodies: new Map() };
  for (const entry of entries) {
    const remaining = allSources.filter((source) => source.entry_id === entry.id && liveItems.has(source.item_id)).length;
    const cascade = cascadeSections(entry.body_markdown ?? "", itemIds);
    const emptied = cascade.removedSectionIds.length > 0 && stripSectionMarkers(cascade.body).trim() === "";
    if (remaining > 0 && (!emptied || entry.user_edited)) plan.toUpdate.push(entry);
    else if (entry.user_edited) plan.toOrphan.push(entry);
    else {
      plan.toDelete.push(entry);
      continue;
    }
    if (cascade.changed) plan.bodies.set(entry.id, { body: cascade.body, removedSectionIds: cascade.removedSectionIds });
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
    entriesToStale: plan.toUpdate.map(brief),
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
  const orphan = db.prepare("UPDATE kb_entries SET orphan = 1 WHERE id = ?");
  for (const entry of plan.toOrphan) orphan.run(entry.id);

  const bodies: NonNullable<ItemTrashPayload["kb"]["bodies"]> = [];
  const noteAnchors: NonNullable<ItemTrashPayload["kb"]["noteAnchors"]> = [];
  const updateBody = db.prepare("UPDATE kb_entries SET body_markdown = ?, updated_at = ? WHERE id = ?");
  const anchoredNotes = db.prepare(
    "SELECT id, anchor FROM notes WHERE scope = 'entry' AND target_id = ? AND anchor IN (SELECT value FROM json_each(?))"
  );
  const clearAnchor = db.prepare("UPDATE notes SET anchor = NULL WHERE id = ?");
  for (const [entryId, next] of plan.bodies) {
    updateBody.run(next.body, nowIso, entryId);
    bodies.push({ entryId, after: next.body });
    for (const note of anchoredNotes.all(entryId, JSON.stringify(next.removedSectionIds)) as Array<{ id: string; anchor: string }>) {
      clearAnchor.run(note.id);
      noteAnchors.push({ id: note.id, anchor: note.anchor });
    }
  }

  const deleteResult = db.prepare("DELETE FROM organize_results WHERE item_id = ?");
  for (const result of organizeResults) deleteResult.run(result.item_id);

  return {
    entries: [...plan.toDelete, ...plan.toUpdate, ...plan.toOrphan],
    deletedEntryIds,
    sources: plan.sources,
    edges: [...edges.values()],
    edgeSources: [...edgeSources.values()],
    organizeResults,
    bodies,
    noteAnchors
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
export function deleteItems(db: DatabaseSync, request: DeleteItemsRequest, now = new Date(), options: { searchIndex?: KbSearchIndex } = {}): DeleteItemsResponse {
  const { response, kb } = withTransaction(db, () => {
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
    return { response: { trashId: record.id, deletedItemCount: items.length, deletedNoteCount: notes.length }, kb };
  });
  removeEntriesFromIndex(options.searchIndex, kb.deletedEntryIds);
  void reindexEntries(options.searchIndex, db, (kb.bodies ?? []).map((body) => body.entryId));
  return response;
}
