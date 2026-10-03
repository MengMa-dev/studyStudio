import type { DatabaseSync } from "node:sqlite";
import type { TimelineRowType } from "@study-studio/shared";
import { getTimeline } from "../../timeline/timeline.js";
import { resolveRange } from "../../timeline/time.js";
import type { CitationRegistry } from "../contracts.js";

export const TIMELINE_ROWS_PER_DAY = 15;

export type TimelineToolRow = {
  ref?: number;
  type: TimelineRowType;
  title: string;
  site: string | null;
  minutes: number | null;
  itemId: string | null;
};

export type TimelineToolDay = { ref: number; day: string; minutes: number; rows: TimelineToolRow[]; moreRows: number };

export type TimelineToolResult = { from: string; to: string; totalMinutes: number; days: TimelineToolDay[]; note?: "no_records" };

export function queryTimeline(db: DatabaseSync, registry: CitationRegistry, input: { from?: string; to?: string }, now: Date): TimelineToolResult {
  const range = resolveRange(input.from, input.to, now);
  const timeline = getTimeline(db, range, now);
  const days = timeline.days.map((day): TimelineToolDay => {
    const ref = registry.register({ kind: "day", id: day.day, title: `${day.day} 学习记录` });
    const rows = day.rows.slice(0, TIMELINE_ROWS_PER_DAY).map((row): TimelineToolRow => {
      const out: TimelineToolRow = {
        type: row.type,
        title: row.title,
        site: row.site,
        minutes: row.durationSeconds === null ? null : Math.round(row.durationSeconds / 60),
        itemId: row.itemId
      };
      if (row.itemId) out.ref = registry.register({ kind: "item", id: row.itemId, title: row.title || row.itemId });
      return out;
    });
    return { ref, day: day.day, minutes: day.minutes, rows, moreRows: Math.max(0, day.rows.length - rows.length) };
  });
  const result: TimelineToolResult = { ...range, totalMinutes: days.reduce((sum, day) => sum + day.minutes, 0), days };
  if (days.length === 0) result.note = "no_records";
  return result;
}
