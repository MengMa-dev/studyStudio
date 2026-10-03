import type { DatabaseSync } from "node:sqlite";
import type { KbEdgeRow, KbEdgeSourceRow, KbEntryRow, KbEntrySourceRow, NoteRow, TrashRow } from "../../db/types.js";
import { ENTRY_COLUMNS, parseJson } from "./queries.js";
import { reindexEntries, type KbSearchIndex } from "./search-sync.js";

export const KB_TRASH_KIND = "entries";

/** `trash.snapshot` for `kind=entries`; everything needed to undo a KB delete in one step. */
export type KbTrashSnapshot = {
  version: 1;
  kind: typeof KB_TRASH_KIND;
  /** List label, e.g.「交叉编码器」or「交叉编码器 等 3 个知识点」. */
  title: string;
  entryIds: string[];
  deletedAt: string;
  /** Rows before the delete (`deleted_at` null). */
  entries: KbEntryRow[];
  /** Removed edges touching the deleted entries, with provenance. */
  edges: KbEdgeRow[];
  edgeSources: KbEdgeSourceRow[];
  entrySources: KbEntrySourceRow[];
  /** Entry notes soft-deleted by this operation. */
  notes: NoteRow[];
  /** `part_of` edges added to move surviving children up; removed on restore. */
  reparentEdges: KbEdgeRow[];
  /** Names newly inserted into `kb_ignore`; removed on restore. */
  ignoredNames: string[];
};

export type KbTrashRestoreResult = {
  restoredItemCount: number;
  restoredNoteCount: number;
  restoredEntryCount: number;
};

/** Shape expected by `registerTrashHandler(kind, handler)` in `domains/trash/registry.ts`. */
export type KbTrashHandler = {
  restore(db: DatabaseSync, trashRow: TrashRow): KbTrashRestoreResult;
  purge(db: DatabaseSync, trashRow: TrashRow): void;
};

export function parseKbTrashSnapshot(trashRow: Pick<TrashRow, "snapshot">): KbTrashSnapshot {
  const parsed = parseJson(trashRow.snapshot) as Partial<KbTrashSnapshot> | null;
  if (!parsed || parsed.kind !== KB_TRASH_KIND || !Array.isArray(parsed.entries)) {
    throw new Error("invalid kb trash snapshot");
  }
  return {
    version: 1,
    kind: KB_TRASH_KIND,
    title: parsed.title ?? "",
    entryIds: parsed.entryIds ?? parsed.entries.map((entry) => entry.id),
    deletedAt: parsed.deletedAt ?? "",
    entries: parsed.entries,
    edges: parsed.edges ?? [],
    edgeSources: parsed.edgeSources ?? [],
    entrySources: parsed.entrySources ?? [],
    notes: parsed.notes ?? [],
    reparentEdges: parsed.reparentEdges ?? [],
    ignoredNames: parsed.ignoredNames ?? []
  };
}

let savepointSeq = 0;

/** Nests inside a caller's transaction (e.g. the trash registry) as well as running standalone. */
function withSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const name = `kb_trash_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}

function restoreSnapshot(db: DatabaseSync, snapshot: KbTrashSnapshot): KbTrashRestoreResult {
  const insertEntry = db.prepare(`INSERT OR REPLACE INTO kb_entries (${ENTRY_COLUMNS.join(", ")}) VALUES (${ENTRY_COLUMNS.map(() => "?").join(", ")})`);
  for (const entry of snapshot.entries) {
    insertEntry.run(...ENTRY_COLUMNS.map((column) => (column === "deleted_at" ? null : (entry[column] ?? null))));
  }

  const deleteEdge = db.prepare("DELETE FROM kb_edges WHERE src = ? AND dst = ? AND type = ?");
  for (const edge of snapshot.reparentEdges) deleteEdge.run(edge.src, edge.dst, edge.type);

  const insertEdge = db.prepare("INSERT OR IGNORE INTO kb_edges (src, dst, type) VALUES (?, ?, ?)");
  for (const edge of snapshot.edges) insertEdge.run(edge.src, edge.dst, edge.type);

  const edgeSourceExists = db.prepare("SELECT 1 FROM kb_edge_sources WHERE src = ? AND dst = ? AND type = ? AND item_id IS ? AND description IS ? LIMIT 1");
  const insertEdgeSource = db.prepare("INSERT INTO kb_edge_sources (src, dst, type, item_id, description) VALUES (?, ?, ?, ?, ?)");
  for (const row of snapshot.edgeSources) {
    if (!edgeSourceExists.get(row.src, row.dst, row.type, row.item_id, row.description)) {
      insertEdgeSource.run(row.src, row.dst, row.type, row.item_id, row.description);
    }
  }

  const insertSource = db.prepare("INSERT OR IGNORE INTO kb_entry_sources (entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, ?, ?)");
  for (const row of snapshot.entrySources) insertSource.run(row.entry_id, row.item_id, row.evidence, row.source_kind, row.added_at);

  // Only undo our own soft delete: notes deleted later by the user keep their newer deleted_at.
  const restoreNote = db.prepare("UPDATE notes SET deleted_at = NULL WHERE id = ? AND deleted_at = ?");
  let restoredNoteCount = 0;
  for (const note of snapshot.notes) {
    restoredNoteCount += Number(restoreNote.run(note.id, snapshot.deletedAt).changes);
  }

  const deleteIgnore = db.prepare("DELETE FROM kb_ignore WHERE name = ?");
  for (const name of snapshot.ignoredNames) deleteIgnore.run(name);

  return { restoredItemCount: 0, restoredNoteCount, restoredEntryCount: snapshot.entries.length };
}

function purgeSnapshot(db: DatabaseSync, snapshot: KbTrashSnapshot): void {
  const ids = JSON.stringify(snapshot.entryIds);
  // Restored entries have deleted_at NULL and must survive a stale purge.
  db.prepare("DELETE FROM kb_entries WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))").run(ids);
  const purged = `(SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM kb_entries))`;
  db.prepare(`DELETE FROM kb_edges WHERE src IN ${purged} OR dst IN ${purged}`).run(ids, ids);
  db.prepare(`DELETE FROM kb_edge_sources WHERE src IN ${purged} OR dst IN ${purged}`).run(ids, ids);
  db.prepare(`DELETE FROM kb_entry_sources WHERE entry_id IN ${purged}`).run(ids);
  const deleteNote = db.prepare("DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL");
  for (const note of snapshot.notes) deleteNote.run(note.id);
}

/**
 * Restore / purge for trash rows with `kind=entries`. The handler does not delete the trash row itself;
 * the trash registry does that after a successful call.
 */
export function createKbTrashHandler(options: { searchIndex?: KbSearchIndex } = {}): KbTrashHandler {
  return {
    restore(db, trashRow) {
      const snapshot = parseKbTrashSnapshot(trashRow);
      const result = withSavepoint(db, () => restoreSnapshot(db, snapshot));
      void reindexEntries(options.searchIndex, db, snapshot.entryIds);
      return result;
    },
    purge(db, trashRow) {
      const snapshot = parseKbTrashSnapshot(trashRow);
      withSavepoint(db, () => purgeSnapshot(db, snapshot));
    }
  };
}

export const kbTrashHandler: KbTrashHandler = createKbTrashHandler();
