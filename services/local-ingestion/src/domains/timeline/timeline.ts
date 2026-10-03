import type { DatabaseSync } from "node:sqlite";
import {
  timelineRowTypeSchema,
  type OverviewPending,
  type OverviewResponse,
  type OverviewToday,
  type TimelineQuery,
  type TimelineResponse,
  type TimelineRowType
} from "@study-studio/shared";
import { collectActivities, type Activity } from "./activity.js";
import { addDays, dayLabel, daysBetween, localDay, resolveRange, weekdayLabel } from "./time.js";

/** Entries with mastery below this count as weak. */
export const WEAK_MASTERY = 0.3;
const STREAK_LOOKBACK_DAYS = 366;

function secondsByDay(activities: Activity[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const activity of activities) map.set(activity.day, (map.get(activity.day) ?? 0) + (activity.seconds ?? 0));
  return map;
}

const toMinutes = (seconds: number) => Math.round(seconds / 60);

export function parseTypes(raw: string | undefined): Set<TimelineRowType> | null {
  if (!raw) return null;
  const types = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is TimelineRowType => timelineRowTypeSchema.safeParse(value).success);
  return new Set(types);
}

export function getTimeline(db: DatabaseSync, query: TimelineQuery, now = new Date()): TimelineResponse {
  const range = resolveRange(query.from, query.to, now);
  const today = localDay(now);
  const types = parseTypes(query.types);
  const activities = collectActivities(db, range);
  const seconds = secondsByDay(activities);
  const days = daysBetween(range.from, range.to).reverse();
  return {
    days: days
      .map((day) => ({
        day,
        label: dayLabel(day, today),
        minutes: toMinutes(seconds.get(day) ?? 0),
        rows: activities
          .filter((activity) => activity.day === day && (!types || types.has(activity.type)))
          .map((activity) => ({
            id: activity.id,
            type: activity.type,
            startedAt: activity.startedAt,
            title: activity.title,
            site: activity.site,
            itemId: activity.itemId,
            noteId: activity.noteId,
            durationSeconds: activity.seconds,
            tags: activity.tags
          }))
      }))
      .filter((day) => day.rows.length > 0)
  };
}

export function getPending(db: DatabaseSync): OverviewPending {
  const count = (sql: string, ...params: number[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);
  return {
    unread: count("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND read_status = 'unread'"),
    pendingOrganize: count("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND organize_status IN ('pending', 'failed')"),
    weakEntries: count("SELECT COUNT(*) AS n FROM kb_entries WHERE deleted_at IS NULL AND mastery IS NOT NULL AND mastery < ?", WEAK_MASTERY)
  };
}

/** Consecutive days with learning time, ending today (or yesterday when today has none yet). */
function streak(seconds: Map<string, number>, today: string): number {
  let day = (seconds.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  let count = 0;
  while ((seconds.get(day) ?? 0) > 0 && count < STREAK_LOOKBACK_DAYS) {
    count += 1;
    day = addDays(day, -1);
  }
  return count;
}

export function getToday(db: DatabaseSync, now = new Date()): OverviewToday {
  const today = localDay(now);
  const history = collectActivities(db, { from: addDays(today, -(STREAK_LOOKBACK_DAYS - 1)), to: today });
  const seconds = secondsByDay(history);
  const todays = history.filter((activity) => activity.day === today);
  const notesToday = (
    db.prepare("SELECT created_at FROM notes WHERE deleted_at IS NULL AND created_at >= ?").all(addDays(today, -1)) as { created_at: string }[]
  ).filter((note) => localDay(note.created_at) === today).length;
  const capturedToday = (type: "webpage" | "conversation") =>
    (
      db.prepare("SELECT captured_at FROM items WHERE deleted_at IS NULL AND type = ? AND captured_at >= ?").all(type, addDays(today, -1)) as {
        captured_at: string;
      }[]
    ).filter((item) => localDay(item.captured_at) === today).length;
  return {
    minutes: toMinutes(todays.reduce((sum, activity) => sum + (activity.seconds ?? 0), 0)),
    pages: capturedToday("webpage"),
    qa: capturedToday("conversation"),
    notes: notesToday,
    streak: streak(seconds, today)
  };
}

export function getOverview(db: DatabaseSync, query: { from?: string; to?: string }, now = new Date()): OverviewResponse {
  const today = localDay(now);
  const range = resolveRange(query.from, query.to, now);
  const weekEnd = range.to;
  const weekDays = daysBetween(addDays(weekEnd, -6), weekEnd);
  const activities = collectActivities(db, { from: weekDays[0]! < range.from ? weekDays[0]! : range.from, to: range.to });
  const seconds = secondsByDay(activities);

  const sources = new Map<string, number>();
  for (const activity of activities) {
    if (activity.day < range.from || !activity.source || !activity.seconds) continue;
    sources.set(activity.source, (sources.get(activity.source) ?? 0) + activity.seconds);
  }

  return {
    today: getToday(db, now),
    week: weekDays.map((day) => ({ day: day === today ? "今天" : weekdayLabel(day), minutes: toMinutes(seconds.get(day) ?? 0) })),
    sources: [...sources.entries()]
      .map(([name, total]) => ({ name, minutes: toMinutes(total) }))
      .filter((source) => source.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
      .slice(0, 8),
    pending: getPending(db)
  };
}
