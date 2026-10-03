import type { DatabaseSync } from "node:sqlite";
import type { InboxBulkAction, InboxItemDetail, InboxItemPatch } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import type { ItemContentRow, ItemRow, NoteRow, ReadingSessionRow } from "../../db/types.js";
import { toNote } from "../notes/notes.js";
import { tagsByItem } from "./list.js";

export function getActiveItem(db: DatabaseSync, id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL").get(id) as ItemRow | undefined;
}

export function getItemDetail(db: DatabaseSync, id: string): InboxItemDetail | null {
  const item = getActiveItem(db, id);
  if (!item) return null;
  const content = db.prepare("SELECT * FROM item_contents WHERE item_id = ?").get(id) as ItemContentRow | undefined;
  const sessions = db.prepare("SELECT * FROM reading_sessions WHERE item_id = ? ORDER BY started_at, rowid").all(id) as ReadingSessionRow[];
  const notes = (
    db.prepare("SELECT * FROM notes WHERE scope = 'item' AND target_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").all(id) as NoteRow[]
  ).map(toNote);
  const related = db
    .prepare(
      `SELECT e.id, e.name, e.mastery FROM kb_entry_sources s JOIN kb_entries e ON e.id = s.entry_id
       WHERE s.item_id = ? AND e.deleted_at IS NULL ORDER BY e.name`
    )
    .all(id) as { id: string; name: string; mastery: number | null }[];

  return {
    id: item.id,
    type: item.type,
    title: item.title ?? item.url ?? "",
    url: item.url,
    site: item.site,
    capturedAt: item.captured_at,
    reason: item.reason,
    readStatus: item.read_status,
    organizeStatus: item.organize_status,
    dirty: Boolean(item.dirty),
    tags: tagsByItem(db, [id]).get(id) ?? [],
    readingTotalSeconds: Math.max(0, Math.floor(item.reading_total_seconds ?? 0)),
    readingSessionCount: Math.max(0, Math.floor(item.reading_session_count ?? 0)),
    lastReadAt: item.last_read_at,
    markdown: content?.markdown ?? content?.plain_text ?? null,
    question: content?.question ?? null,
    reasoning: content?.reasoning ?? null,
    editedAt: item.edited_at,
    unusedNoteCount: notes.filter((note) => !note.usedAt).length,
    readingSessions: sessions.map((session) => ({
      id: session.id,
      startedAt: session.started_at ?? item.captured_at,
      seconds: Math.max(0, Math.floor(session.seconds)),
      isFirst: Boolean(session.is_first)
    })),
    notes,
    relatedEntries: related.map((entry) => ({
      id: entry.id,
      name: entry.name,
      mastery: entry.mastery === null ? null : Math.min(1, Math.max(0, entry.mastery))
    }))
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function setTags(db: DatabaseSync, itemId: string, tags: readonly string[]): void {
  db.prepare("DELETE FROM tags WHERE item_id = ?").run(itemId);
  const insert = db.prepare("INSERT OR IGNORE INTO tags(item_id, tag) VALUES (?, ?)");
  for (const tag of normalizeTags(tags)) insert.run(itemId, tag);
}

/**
 * Editing markdown backs up the original once into `original_markdown`, stamps `edited_at` and sets `dirty=1`.
 * It never triggers organize on its own.
 */
export function patchItem(db: DatabaseSync, id: string, patch: InboxItemPatch, now = new Date()): InboxItemDetail | null {
  const found = withTransaction(db, () => {
    const item = getActiveItem(db, id);
    if (!item) return false;
    if (patch.readStatus) db.prepare("UPDATE items SET read_status = ? WHERE id = ?").run(patch.readStatus, id);
    if (patch.title) db.prepare("UPDATE items SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.tags) setTags(db, id, patch.tags);
    if (patch.markdown !== undefined) {
      const content = db.prepare("SELECT * FROM item_contents WHERE item_id = ?").get(id) as ItemContentRow | undefined;
      if (!content) {
        db.prepare("INSERT INTO item_contents(item_id, markdown, original_markdown) VALUES (?, ?, NULL)").run(id, patch.markdown);
      } else if (content.original_markdown === null) {
        db.prepare("UPDATE item_contents SET original_markdown = COALESCE(markdown, plain_text, ''), markdown = ? WHERE item_id = ?").run(patch.markdown, id);
      } else {
        db.prepare("UPDATE item_contents SET markdown = ? WHERE item_id = ?").run(patch.markdown, id);
      }
      db.prepare("UPDATE items SET edited_at = ?, dirty = 1 WHERE id = ?").run(now.toISOString(), id);
    }
    return true;
  });
  return found ? getItemDetail(db, id) : null;
}

export function bulkUpdateItems(db: DatabaseSync, action: InboxBulkAction): number {
  return withTransaction(db, () => {
    let updated = 0;
    for (const id of new Set(action.ids)) {
      if (!getActiveItem(db, id)) continue;
      if (action.action === "read_status") {
        db.prepare("UPDATE items SET read_status = ? WHERE id = ?").run(action.readStatus, id);
      } else if (action.mode === "set") {
        setTags(db, id, action.tags);
      } else {
        const insert = db.prepare("INSERT OR IGNORE INTO tags(item_id, tag) VALUES (?, ?)");
        for (const tag of normalizeTags(action.tags)) insert.run(id, tag);
      }
      updated += 1;
    }
    return updated;
  });
}
