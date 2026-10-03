const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day (server time zone) of a Date or ISO timestamp. */
export function localDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isDay(value: string | undefined): value is string {
  return Boolean(value && DAY_RE.test(value) && !Number.isNaN(parseDay(value).getTime()));
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(day: string, delta: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + delta);
  return localDay(date);
}

/** Inclusive list of days from `from` to `to`, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length < 3660; day = addDays(day, 1)) days.push(day);
  return days;
}

export function weekdayLabel(day: string): string {
  return WEEKDAYS[parseDay(day).getDay()]!;
}

/** "今天 · 10月2日 周五" / "昨天 · 10月1日 周四" / "周三 · 9月30日" (year added outside the current year). */
export function dayLabel(day: string, today: string): string {
  const date = parseDay(day);
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  const withYear = day.slice(0, 4) === today.slice(0, 4) ? md : `${date.getFullYear()}年${md}`;
  if (day === today) return `今天 · ${withYear} ${weekdayLabel(day)}`;
  if (day === addDays(today, -1)) return `昨天 · ${withYear} ${weekdayLabel(day)}`;
  return `${weekdayLabel(day)} · ${withYear}`;
}

export type DayRange = { from: string; to: string };

/** Defaults to the last 7 days ending today; swaps reversed bounds. */
export function resolveRange(from: string | undefined, to: string | undefined, now: Date, defaultDays = 7): DayRange {
  const today = localDay(now);
  const end = isDay(to) ? to : today;
  const start = isDay(from) ? from : addDays(end, -(defaultDays - 1));
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/** ISO bounds padded by a day on each side; callers re-filter by `localDay`. */
export function isoWindow(range: DayRange): { start: string; end: string } {
  return { start: parseDay(addDays(range.from, -1)).toISOString(), end: parseDay(addDays(range.to, 2)).toISOString() };
}
