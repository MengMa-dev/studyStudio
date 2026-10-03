import type { DatabaseSync } from "node:sqlite";
import type { TimelineRowType } from "@study-studio/shared";
import type { ItemRow, NoteRow } from "../../db/types.js";
import { parseJson, selectIn } from "../inbox/sql.js";
import { isoWindow, localDay, type DayRange } from "./time.js";

/** One answer counts at most 10 minutes of learning time (question sent → answer completed). */
export const MAX_QA_SECONDS = 600;

export type Activity = {
  id: string;
  type: TimelineRowType;
  day: string;
  startedAt: string;
  title: string;
  site: string | null;
  /** Site or conversation platform used for the source distribution. */
  source: string | null;
  itemId: string | null;
  noteId: string | null;
  seconds: number | null;
  tags: string[];
};

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, "ChatGPT"],
  [/(^|\.)deepseek\.com$/, "DeepSeek"]
];

export function platformName(site: string | null): string | null {
  if (!site) return null;
  for (const [pattern, name] of PLATFORMS) if (pattern.test(site)) return name;
  return site;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function webpageActivities(db: DatabaseSync, range: DayRange): Activity[] {
  const { start, end } = isoWindow(range);
  const captured = db
    .prepare("SELECT * FROM items WHERE type = 'webpage' AND deleted_at IS NULL AND captured_at >= ? AND captured_at < ?")
    .all(start, end) as ItemRow[];
  const reads = db
    .prepare(
      `SELECT e.item_id, e.occurred_at, e.payload FROM events e JOIN items i ON i.id = e.item_id
       WHERE e.type = 'reading_session_closed' AND i.type = 'webpage' AND i.deleted_at IS NULL AND e.occurred_at >= ? AND e.occurred_at < ?`
    )
    .all(start, end) as { item_id: string; occurred_at: string; payload: string }[];

  type Bucket = { itemId: string; day: string; startMs: number; seconds: number; reads: number; captured: boolean };
  const buckets = new Map<string, Bucket>();
  const bucket = (itemId: string, startMs: number) => {
    const day = localDay(new Date(startMs));
    const key = `${itemId}\n${day}`;
    let value = buckets.get(key);
    if (!value) {
      value = { itemId, day, startMs, seconds: 0, reads: 0, captured: false };
      buckets.set(key, value);
    }
    value.startMs = Math.min(value.startMs, startMs);
    return value;
  };

  for (const item of captured) {
    const ms = toMs(item.captured_at);
    if (ms !== null) bucket(item.id, ms).captured = true;
  }
  for (const read of reads) {
    const payload = parseJson<{ countedSeconds?: number; openedAt?: string }>(read.payload, {});
    const seconds = Math.max(0, Math.floor(payload.countedSeconds ?? 0));
    const endMs = toMs(read.occurred_at);
    if (endMs === null) continue;
    const startMs = toMs(payload.openedAt) ?? endMs - seconds * 1000;
    const value = bucket(read.item_id, startMs);
    value.seconds += seconds;
    value.reads += 1;
  }

  const itemIds = [...new Set([...buckets.values()].map((value) => value.itemId))];
  const items = new Map(selectIn<ItemRow>(db, (list) => `SELECT * FROM items WHERE id IN (${list})`, itemIds).map((row) => [row.id, row]));
  const out: Activity[] = [];
  for (const value of buckets.values()) {
    const item = items.get(value.itemId);
    if (!item) continue;
    const tags: string[] = [];
    if (value.captured) tags.push("已收集");
    if (value.reads > 1) tags.push(`阅读 ${value.reads} 次`);
    out.push({
      id: `webpage:${item.id}:${value.day}`,
      type: "webpage",
      day: value.day,
      startedAt: new Date(value.startMs).toISOString(),
      title: item.title ?? item.url ?? "",
      site: item.site,
      source: item.site,
      itemId: item.id,
      noteId: null,
      seconds: value.seconds,
      tags
    });
  }
  return out;
}

function conversationActivities(db: DatabaseSync, range: DayRange): Activity[] {
  const { start, end } = isoWindow(range);
  const items = db
    .prepare("SELECT * FROM items WHERE type = 'conversation' AND deleted_at IS NULL AND captured_at >= ? AND captured_at < ?")
    .all(start, end) as ItemRow[];
  const asked = new Map<string, number>();
  const questions = selectIn<{ item_id: string; occurred_at: string }>(
    db,
    (list) => `SELECT item_id, occurred_at FROM events WHERE type = 'user_message_sent' AND item_id IN (${list})`,
    items.map((item) => item.id)
  );
  for (const question of questions) {
    const ms = toMs(question.occurred_at);
    if (ms === null) continue;
    asked.set(question.item_id, Math.min(asked.get(question.item_id) ?? ms, ms));
  }

  const out: Activity[] = [];
  for (const item of items) {
    const answeredMs = toMs(item.captured_at);
    if (answeredMs === null) continue;
    const askedMs = asked.get(item.id);
    const startMs = askedMs !== undefined && askedMs <= answeredMs ? askedMs : answeredMs;
    const seconds = askedMs !== undefined ? Math.min(MAX_QA_SECONDS, Math.max(0, Math.round((answeredMs - startMs) / 1000))) : null;
    const platform = platformName(item.site);
    out.push({
      id: `conversation:${item.id}`,
      type: "conversation",
      day: localDay(new Date(startMs)),
      startedAt: new Date(startMs).toISOString(),
      title: platform ? `${platform} · ${item.title ?? ""}` : (item.title ?? ""),
      site: platform,
      source: platform,
      itemId: item.id,
      noteId: null,
      seconds,
      tags: ["已回答"]
    });
  }
  return out;
}

function fuzzyActivities(db: DatabaseSync, range: DayRange): Activity[] {
  const { start, end } = isoWindow(range);
  const notes = db
    .prepare("SELECT * FROM notes WHERE scope = 'fuzzy' AND deleted_at IS NULL AND created_at >= ? AND created_at < ?")
    .all(start, end) as NoteRow[];
  return notes.map((note) => ({
    id: `fuzzy:${note.id}`,
    type: "fuzzy" as const,
    day: localDay(note.created_at),
    startedAt: note.created_at,
    title: note.text,
    site: null,
    source: null,
    itemId: null,
    noteId: note.id,
    seconds: null,
    tags: ["模糊备注"]
  }));
}

/** Server-side aggregation of 04: one row per conversation item, per webpage item and day, per fuzzy note. */
export function collectActivities(db: DatabaseSync, range: DayRange): Activity[] {
  return [...webpageActivities(db, range), ...conversationActivities(db, range), ...fuzzyActivities(db, range)]
    .filter((activity) => activity.day >= range.from && activity.day <= range.to)
    .sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1));
}
