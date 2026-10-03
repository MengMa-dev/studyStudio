import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/** Runs `SELECT ... WHERE col IN (?)` in chunks to stay below SQLite's variable limit. */
export function selectIn<T>(db: DatabaseSync, sql: (inList: string) => string, ids: readonly string[], extra: SQLInputValue[] = []): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...(db.prepare(sql(placeholders(chunk.length))).all(...extra, ...chunk) as T[]));
  }
  return out;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
