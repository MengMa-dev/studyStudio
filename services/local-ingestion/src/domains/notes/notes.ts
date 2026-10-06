import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseSections, type CreateNoteRequest, type Note, type NotesListQuery } from "@study-studio/shared";
import type { NoteRow } from "../../db/types.js";

export class NoteTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteTargetError";
  }
}

export function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    scope: row.scope,
    targetId: row.target_id,
    text: row.text,
    origin: row.origin,
    anchor: row.anchor ?? null,
    usedAt: row.used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    derivedFrom: row.derived_from
  };
}

export function listNotes(db: DatabaseSync, query: NotesListQuery): Note[] {
  const where = ["deleted_at IS NULL"];
  const params: SQLInputValue[] = [];
  if (query.scope) {
    where.push("scope = ?");
    params.push(query.scope);
  }
  if (query.targetId) {
    where.push("target_id = ?");
    params.push(query.targetId);
  }
  const rows = db.prepare(`SELECT * FROM notes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`).all(...params) as NoteRow[];
  return rows.map(toNote);
}

export function getNote(db: DatabaseSync, id: string): NoteRow | undefined {
  return db.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL").get(id) as NoteRow | undefined;
}

/** A new or edited note on an already organized item leaves the item dirty; manual organize consumes it. */
function markItemDirty(db: DatabaseSync, itemId: string): void {
  db.prepare("UPDATE items SET dirty = 1 WHERE id = ? AND deleted_at IS NULL AND organize_status IN ('ingested', 'rejected')").run(itemId);
}

export function createNote(db: DatabaseSync, input: CreateNoteRequest, now = new Date()): Note {
  const targetId = input.scope === "fuzzy" ? null : (input.targetId ?? null);
  const anchor = input.anchor ?? null;
  if (anchor && input.scope !== "entry") throw new NoteTargetError("anchor is only allowed on entry notes");
  if (input.scope !== "fuzzy") {
    if (!targetId) throw new NoteTargetError("targetId is required");
    const table = input.scope === "item" ? "items" : "kb_entries";
    const target = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(targetId) as { body_markdown?: string | null } | undefined;
    if (!target) throw new NoteTargetError(`${input.scope} target not found`);
    if (anchor && !parseSections(target.body_markdown ?? "").some((section) => section.id === anchor)) {
      throw new NoteTargetError("anchor section not found");
    }
  }
  const row: NoteRow = {
    id: randomUUID(),
    scope: input.scope,
    target_id: targetId,
    text: input.text,
    origin: input.origin,
    anchor,
    derived_from: null,
    used_at: null,
    created_at: now.toISOString(),
    updated_at: null,
    deleted_at: null
  };
  db.prepare("INSERT INTO notes(id, scope, target_id, text, origin, anchor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.scope,
    row.target_id,
    row.text,
    row.origin,
    row.anchor ?? null,
    row.created_at
  );
  if (row.scope === "item" && row.target_id) markItemDirty(db, row.target_id);
  return toNote(row);
}

/** Editing clears `used_at` so the note counts as unused again. */
export function patchNote(db: DatabaseSync, id: string, text: string, now = new Date()): Note | null {
  const existing = getNote(db, id);
  if (!existing) return null;
  db.prepare("UPDATE notes SET text = ?, updated_at = ?, used_at = NULL WHERE id = ?").run(text, now.toISOString(), id);
  if (existing.scope === "item" && existing.target_id) markItemDirty(db, existing.target_id);
  return toNote(getNote(db, id)!);
}

export function deleteNote(db: DatabaseSync, id: string, now = new Date()): boolean {
  const result = db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now.toISOString(), id);
  return Number(result.changes) > 0;
}
