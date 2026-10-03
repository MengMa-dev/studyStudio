import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { inboxCursorSchema, type InboxCursor, type InboxListQuery, type InboxListResponse, type InboxListRow } from "@study-studio/shared";
import type { ItemRow, NoteRow } from "../../db/types.js";
import { selectIn } from "./sql.js";

export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): InboxCursor | null {
  try {
    const parsed = inboxCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const STATUS_WHERE: Record<InboxListQuery["status"], string | null> = {
  all: null,
  unread: "read_status = 'unread'",
  read: "read_status = 'read'",
  pending: "organize_status IN ('pending', 'failed')",
  ingested: "organize_status = 'ingested'",
  rejected: "organize_status = 'rejected'"
};

export function tagsByItem(db: DatabaseSync, itemIds: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows = selectIn<{ item_id: string; tag: string }>(db, (list) => `SELECT item_id, tag FROM tags WHERE item_id IN (${list}) ORDER BY rowid`, itemIds);
  for (const row of rows) {
    const list = map.get(row.item_id) ?? [];
    list.push(row.tag);
    map.set(row.item_id, list);
  }
  return map;
}

export function itemListRow(item: ItemRow, tags: string[]): Extract<InboxListRow, { kind: "item" }> {
  return {
    kind: "item",
    id: item.id,
    type: item.type,
    title: item.title ?? item.url ?? "",
    url: item.url,
    site: item.site,
    capturedAt: item.captured_at,
    readStatus: item.read_status,
    organizeStatus: item.organize_status,
    dirty: Boolean(item.dirty),
    tags,
    readingTotalSeconds: Math.max(0, Math.floor(item.reading_total_seconds ?? 0)),
    readingSessionCount: Math.max(0, Math.floor(item.reading_session_count ?? 0))
  };
}

/** Items ordered by `captured_at DESC, id DESC`; fuzzy notes interleave by `created_at` when type and status are both `all`. */
export function listInbox(db: DatabaseSync, query: InboxListQuery): InboxListResponse {
  const where: string[] = ["deleted_at IS NULL"];
  const params: SQLInputValue[] = [];
  if (query.type !== "all") {
    where.push("type = ?");
    params.push(query.type);
  }
  const status = STATUS_WHERE[query.status];
  if (status) where.push(status);

  const includeFuzzy = query.type === "all" && query.status === "all";
  const union = `SELECT 'item' AS kind, id, captured_at AS at FROM items WHERE ${where.join(" AND ")}${
    includeFuzzy ? " UNION ALL SELECT 'fuzzy_note' AS kind, id, created_at AS at FROM notes WHERE scope = 'fuzzy' AND deleted_at IS NULL" : ""
  }`;

  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...params) as { n: number }).n);

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const pageParams = [...params];
  let cursorWhere = "";
  if (cursor) {
    cursorWhere = "WHERE at < ? OR (at = ? AND id < ?)";
    pageParams.push(cursor.capturedAt, cursor.capturedAt, cursor.id);
  }
  const keys = db.prepare(`SELECT kind, id, at FROM (${union}) ${cursorWhere} ORDER BY at DESC, id DESC LIMIT ?`).all(...pageParams, query.limit + 1) as {
    kind: "item" | "fuzzy_note";
    id: string;
    at: string;
  }[];

  const hasMore = keys.length > query.limit;
  const page = keys.slice(0, query.limit);
  const itemIds = page.filter((key) => key.kind === "item").map((key) => key.id);
  const noteIds = page.filter((key) => key.kind === "fuzzy_note").map((key) => key.id);
  const items = new Map(selectIn<ItemRow>(db, (list) => `SELECT * FROM items WHERE id IN (${list})`, itemIds).map((row) => [row.id, row]));
  const notes = new Map(selectIn<NoteRow>(db, (list) => `SELECT * FROM notes WHERE id IN (${list})`, noteIds).map((row) => [row.id, row]));
  const tags = tagsByItem(db, itemIds);

  const rows: InboxListRow[] = [];
  for (const key of page) {
    if (key.kind === "item") {
      const item = items.get(key.id);
      if (item) rows.push(itemListRow(item, tags.get(item.id) ?? []));
    } else {
      const note = notes.get(key.id);
      if (note) rows.push({ kind: "fuzzy_note", id: note.id, text: note.text, origin: note.origin, createdAt: note.created_at });
    }
  }

  const last = page.at(-1);
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor({ capturedAt: last.at, id: last.id }) : null,
    total
  };
}
