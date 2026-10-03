import type { DatabaseSync } from "node:sqlite";
import type { KbDeleteImpactResponse, KbDeleteRequest, KbDeleteResponse } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import type { KbEdgeRow, KbEdgeSourceRow, KbEntryRow, KbEntrySourceRow, NoteRow } from "../../db/types.js";
import { loadAliveEntries, loadTreeLayout, parentOf, type TreeLayout } from "./queries.js";
import { insertTrashRow, TRASH_RETENTION_DAYS } from "../trash/store.js";
import { removeEntriesFromIndex, type KbSearchIndex } from "./search-sync.js";
import { KB_TRASH_KIND, type KbTrashSnapshot } from "./trash.js";

export const KB_TRASH_RETENTION_DAYS = TRASH_RETENTION_DAYS;

/** Splits `?ids=a,b` and dedupes. */
export function parseIdList(ids: string): string[] {
  return [
    ...new Set(
      ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];
}

type Reparent = { id: string; name: string; newParentId: string | null; newParentName: string | null };

/** Live children of deleted entries move to the nearest surviving ancestor (null = category root). */
function planReparent(targets: Set<string>, layout: TreeLayout, names: Map<string, string>): Reparent[] {
  const plan: Reparent[] = [];
  for (const [id, { parentId }] of layout) {
    if (targets.has(id) || !parentId || !targets.has(parentId)) continue;
    const visited = new Set<string>();
    let candidate: string | null = parentId;
    while (candidate && targets.has(candidate) && !visited.has(candidate)) {
      visited.add(candidate);
      candidate = parentOf(layout, candidate);
    }
    const newParentId = candidate && !targets.has(candidate) ? candidate : null;
    plan.push({ id, name: names.get(id) ?? id, newParentId, newParentName: newParentId ? (names.get(newParentId) ?? null) : null });
  }
  return plan.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function loadTouchingEdges(db: DatabaseSync, idsJson: string): KbEdgeRow[] {
  return db
    .prepare(
      "SELECT src, dst, type FROM kb_edges WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?)) ORDER BY src, dst, type"
    )
    .all(idsJson, idsJson) as KbEdgeRow[];
}

function countRelations(db: DatabaseSync, idsJson: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM kb_edges e
         JOIN kb_entries s ON s.id = e.src AND s.deleted_at IS NULL
         JOIN kb_entries d ON d.id = e.dst AND d.deleted_at IS NULL
        WHERE e.src <> e.dst AND (e.src IN (SELECT value FROM json_each(?)) OR e.dst IN (SELECT value FROM json_each(?)))`
    )
    .get(idsJson, idsJson) as { n: number };
  return Number(row.n);
}

export function getKbDeleteImpact(db: DatabaseSync, ids: readonly string[]): KbDeleteImpactResponse | null {
  const targets = loadAliveEntries(db, ids);
  if (targets.length === 0) return null;
  const targetIds = targets.map((row) => row.id);
  const idsJson = JSON.stringify(targetIds);
  const names = new Map(loadAliveEntries(db).map((row) => [row.id, row.name]));
  const noteCount = db
    .prepare("SELECT COUNT(*) AS n FROM notes WHERE scope = 'entry' AND deleted_at IS NULL AND target_id IN (SELECT value FROM json_each(?))")
    .get(idsJson) as { n: number };
  const sourceItems = db
    .prepare("SELECT COUNT(DISTINCT item_id) AS n FROM kb_entry_sources WHERE entry_id IN (SELECT value FROM json_each(?))")
    .get(idsJson) as { n: number };
  return {
    entries: targets.map((row) => ({ id: row.id, name: row.name })),
    noteCount: Number(noteCount.n),
    relationCount: countRelations(db, idsJson),
    reparentedChildren: planReparent(new Set(targetIds), loadTreeLayout(db), names),
    sourceItemCount: Number(sourceItems.n)
  };
}

function trashTitle(entries: KbEntryRow[]): string {
  const first = entries[0]?.name ?? "";
  return entries.length > 1 ? `${first} 等 ${entries.length} 个知识点` : first;
}

/**
 * DELETE /v1/kb/entries: soft-delete entries (+ entry notes), drop their edges and sources,
 * move children up, optionally write `kb_ignore`, and snapshot everything into `trash` (kind=entries).
 */
export function deleteKbEntries(
  db: DatabaseSync,
  request: KbDeleteRequest,
  options: { searchIndex?: KbSearchIndex; now?: Date } = {}
): KbDeleteResponse | null {
  const now = options.now ?? new Date();
  const deletedAt = now.toISOString();

  const result = withTransaction(db, (): { response: KbDeleteResponse; targetIds: string[] } | null => {
    const requested = [...new Set(request.ids)];
    const entries = loadAliveEntries(db, requested).sort((a, b) => requested.indexOf(a.id) - requested.indexOf(b.id));
    if (entries.length === 0) return null;
    const targetIds = entries.map((row) => row.id);
    const idsJson = JSON.stringify(targetIds);
    const names = new Map(loadAliveEntries(db).map((row) => [row.id, row.name]));
    const reparent = planReparent(new Set(targetIds), loadTreeLayout(db), names);

    const edges = loadTouchingEdges(db, idsJson);
    const edgeSources = db
      .prepare(
        "SELECT src, dst, type, item_id, description FROM kb_edge_sources WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?)) ORDER BY rowid"
      )
      .all(idsJson, idsJson) as KbEdgeSourceRow[];
    const entrySources = db
      .prepare("SELECT entry_id, item_id, evidence, source_kind, added_at FROM kb_entry_sources WHERE entry_id IN (SELECT value FROM json_each(?))")
      .all(idsJson) as KbEntrySourceRow[];
    const notes = db
      .prepare("SELECT * FROM notes WHERE scope = 'entry' AND deleted_at IS NULL AND target_id IN (SELECT value FROM json_each(?))")
      .all(idsJson) as NoteRow[];

    db.prepare("DELETE FROM kb_edges WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))").run(idsJson, idsJson);
    db.prepare("DELETE FROM kb_edge_sources WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))").run(idsJson, idsJson);
    db.prepare("DELETE FROM kb_entry_sources WHERE entry_id IN (SELECT value FROM json_each(?))").run(idsJson);
    db.prepare("UPDATE notes SET deleted_at = ? WHERE scope = 'entry' AND deleted_at IS NULL AND target_id IN (SELECT value FROM json_each(?))").run(
      deletedAt,
      idsJson
    );
    db.prepare("UPDATE kb_entries SET deleted_at = ? WHERE id IN (SELECT value FROM json_each(?))").run(deletedAt, idsJson);

    const reparentEdges: KbEdgeRow[] = [];
    const insertEdge = db.prepare("INSERT OR IGNORE INTO kb_edges (src, dst, type) VALUES (?, ?, 'part_of')");
    for (const child of reparent) {
      if (!child.newParentId) continue;
      if (Number(insertEdge.run(child.id, child.newParentId).changes) > 0) {
        reparentEdges.push({ src: child.id, dst: child.newParentId, type: "part_of" });
      }
    }

    const ignoredNames: string[] = [];
    if (request.ignore) {
      const insertIgnore = db.prepare("INSERT OR IGNORE INTO kb_ignore (name, created_at) VALUES (?, ?)");
      for (const name of new Set(entries.map((row) => row.name.trim()).filter(Boolean))) {
        if (Number(insertIgnore.run(name, deletedAt).changes) > 0) ignoredNames.push(name);
      }
    }

    const snapshot: KbTrashSnapshot = {
      version: 1,
      kind: KB_TRASH_KIND,
      title: trashTitle(entries),
      entryIds: targetIds,
      deletedAt,
      entries,
      edges,
      edgeSources,
      entrySources,
      notes,
      reparentEdges,
      ignoredNames
    };
    const record = insertTrashRow(db, {
      kind: KB_TRASH_KIND,
      targets: { entryIds: targetIds },
      meta: { title: snapshot.title, site: null, itemType: null, removeFromKb: true, removedEntryCount: entries.length },
      payload: snapshot,
      now
    });
    return { response: { trashId: record.id, deletedEntryCount: entries.length }, targetIds };
  });

  if (!result) return null;
  removeEntriesFromIndex(options.searchIndex, result.targetIds);
  return result.response;
}
