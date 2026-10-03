import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_ORGANIZE_SETTINGS, organizeSettingsSchema, type OrganizeSettings } from "@study-studio/shared";
import type { ItemExposureRow, ItemRow, KbEntryRow, NoteRow } from "../../db/types.js";
import { normalizeEntryName } from "./normalize.js";

/** DB reads shared by the organize stages. Writes to KB tables live in `integrate.ts` / `rewrite.ts`. */

export type OrganizeItem = {
  id: string;
  type: ItemRow["type"];
  title: string;
  url: string | null;
  site: string | null;
  capturedAt: string;
  status: ItemRow["organize_status"];
  dirty: boolean;
  contentHash: string | null;
  /** Edited markdown preferred over plain text. */
  body: string;
  plainText: string | null;
  markdown: string | null;
  question: string | null;
  conversationId: string | null;
  readingSeconds: number;
  highlights: string[];
  itemNotes: Array<{ id: string; text: string }>;
  exposure: ItemExposureRow[];
};

type ItemJoinRow = ItemRow & {
  markdown: string | null;
  plain_text: string | null;
  question: string | null;
  meta: string | null;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export function loadItems(db: DatabaseSync, ids: string[]): Map<string, OrganizeItem> {
  const out = new Map<string, OrganizeItem>();
  if (ids.length === 0) return out;
  const select = db.prepare(
    `SELECT i.*, c.markdown, c.plain_text, c.question, c.meta
     FROM items i LEFT JOIN item_contents c ON c.item_id = i.id
     WHERE i.id = ? AND i.deleted_at IS NULL`
  );
  const notes = db.prepare("SELECT id, text FROM notes WHERE scope = 'item' AND target_id = ? AND deleted_at IS NULL ORDER BY created_at");
  const selections = db.prepare("SELECT payload FROM events WHERE item_id = ? AND type = 'selection' ORDER BY occurred_at");
  const exposure = db.prepare("SELECT * FROM item_exposure WHERE item_id = ?");
  for (const id of new Set(ids)) {
    const row = select.get(id) as ItemJoinRow | undefined;
    if (!row) continue;
    const meta = parseJson<{ conversationId?: string }>(row.meta, {});
    const highlights = (selections.all(id) as Array<{ payload: string }>)
      .map((event) => parseJson<{ snippet?: { text?: string } }>(event.payload, {}).snippet?.text?.trim() ?? "")
      .filter(Boolean);
    out.set(id, {
      id,
      type: row.type,
      title: row.title?.trim() || row.question?.slice(0, 120) || row.url || id,
      url: row.url,
      site: row.site,
      capturedAt: row.captured_at,
      status: row.organize_status,
      dirty: row.dirty === 1,
      contentHash: row.content_hash,
      body: (row.markdown || row.plain_text || "").trim(),
      plainText: row.plain_text,
      markdown: row.markdown,
      question: row.question,
      conversationId: meta.conversationId ?? null,
      readingSeconds: row.reading_total_seconds ?? 0,
      highlights: [...new Set(highlights)],
      itemNotes: notes.all(id) as Array<{ id: string; text: string }>,
      exposure: exposure.all(id) as ItemExposureRow[]
    });
  }
  return out;
}

export type EntryRecord = {
  id: string;
  name: string;
  aliases: string[];
  kind: string | null;
  categoryId: string | null;
  summary: string | null;
  body: string;
  completeness: string | null;
  mastery: number | null;
  userEdited: boolean;
  stale: boolean;
  patchCount: number;
  updatedAt: string | null;
};

export function toEntryRecord(row: KbEntryRow): EntryRecord {
  return {
    id: row.id,
    name: row.name,
    aliases: parseStringArray(row.aliases),
    kind: row.kind,
    categoryId: row.category_id,
    summary: row.summary,
    body: row.body_markdown ?? "",
    completeness: row.completeness,
    mastery: row.mastery,
    userEdited: row.user_edited === 1,
    stale: row.stale === 1,
    patchCount: row.patch_count ?? 0,
    updatedAt: row.updated_at
  };
}

export function loadEntry(db: DatabaseSync, id: string): EntryRecord | null {
  const row = db.prepare("SELECT * FROM kb_entries WHERE id = ? AND deleted_at IS NULL").get(id) as KbEntryRow | undefined;
  return row ? toEntryRecord(row) : null;
}

export function listAliveEntries(db: DatabaseSync): EntryRecord[] {
  return (db.prepare("SELECT * FROM kb_entries WHERE deleted_at IS NULL").all() as KbEntryRow[]).map(toEntryRecord);
}

export function lastSourceAt(db: DatabaseSync, entryId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(s.added_at) AS at FROM kb_entry_sources s JOIN items i ON i.id = s.item_id
       WHERE s.entry_id = ? AND i.deleted_at IS NULL`
    )
    .get(entryId) as { at: string | null } | undefined;
  return row?.at ?? null;
}

export function kbIgnoreNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM kb_ignore").all() as Array<{ name: string }>).map((row) => row.name);
}

export function categoryNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM kb_categories WHERE name IS NOT NULL ORDER BY sort, name").all() as Array<{ name: string }>).map((row) => row.name);
}

export function categoryName(db: DatabaseSync, id: string | null): string | null {
  if (!id) return null;
  const row = db.prepare("SELECT name FROM kb_categories WHERE id = ?").get(id) as { name: string | null } | undefined;
  return row?.name ?? null;
}

/** Entry names with a source added in the last 30 days (judge context, max 50). */
export function recentKbTopics(db: DatabaseSync, now: Date): string[] {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return (
    db
      .prepare(
        `SELECT e.name AS name, MAX(s.added_at) AS at FROM kb_entries e JOIN kb_entry_sources s ON s.entry_id = e.id
         WHERE e.deleted_at IS NULL AND s.added_at >= ? GROUP BY e.id ORDER BY at DESC LIMIT 50`
      )
      .all(since) as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Fuzzy notes within ±1 day of the item (07: vector Top-3 ∩ ±1 day; simplified to the 3 closest in time). */
export function fuzzyNotesNear(db: DatabaseSync, capturedAt: string, limit = 3): NoteRow[] {
  const at = Date.parse(capturedAt);
  if (Number.isNaN(at)) return [];
  const from = new Date(at - 86_400_000).toISOString();
  const to = new Date(at + 86_400_000).toISOString();
  const rows = db.prepare("SELECT * FROM notes WHERE scope = 'fuzzy' AND deleted_at IS NULL AND created_at BETWEEN ? AND ?").all(from, to) as NoteRow[];
  return rows.sort((a, b) => Math.abs(Date.parse(a.created_at) - at) - Math.abs(Date.parse(b.created_at) - at)).slice(0, limit);
}

export function entryNotes(db: DatabaseSync, entryId: string): NoteRow[] {
  return db.prepare("SELECT * FROM notes WHERE scope = 'entry' AND target_id = ? AND deleted_at IS NULL ORDER BY created_at").all(entryId) as NoteRow[];
}

export function findEntryByName(entries: EntryRecord[], name: string): EntryRecord | undefined {
  const key = normalizeEntryName(name);
  return entries.find((entry) => normalizeEntryName(entry.name) === key || entry.aliases.some((alias) => normalizeEntryName(alias) === key));
}

/** Markdown headings of an entry body (`outline` in ⑤). */
export function outlineOf(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.trim());
}

const SETTINGS_KEY = "organize";

export function readOrganizeSettings(db: DatabaseSync): OrganizeSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as { value: string | null } | undefined;
  const parsed = organizeSettingsSchema.safeParse(parseJson<unknown>(row?.value, null));
  return parsed.success ? parsed.data : DEFAULT_ORGANIZE_SETTINGS;
}

export function writeOrganizeSettings(db: DatabaseSync, settings: OrganizeSettings): OrganizeSettings {
  const value = organizeSettingsSchema.parse(settings);
  db.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(SETTINGS_KEY, JSON.stringify(value), new Date().toISOString());
  return value;
}

export { parseJson };
