import type { DatabaseSync } from "node:sqlite";
import { SEED_KINDS, type KbKindRename, type KbKindsResponse } from "@study-studio/shared";
import { loadAliveEntries, normalizeKind } from "./queries.js";

const SEEDS: readonly string[] = SEED_KINDS;

/** GET /v1/kb/kinds: seeds first (SEED_KINDS order), then by live entry count desc, name asc. */
export function listKbKinds(db: DatabaseSync): KbKindsResponse {
  const counts = new Map<string, number>(SEEDS.map((name) => [name, 0]));
  for (const row of loadAliveEntries(db)) {
    const kind = normalizeKind(row.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = [...counts].map(([name, entryCount]) => ({ name, entryCount, seed: SEEDS.includes(name) }));
  const rank = (name: string) => (SEEDS.includes(name) ? SEEDS.indexOf(name) : SEEDS.length);
  kinds.sort((a, b) => rank(a.name) - rank(b.name) || b.entryCount - a.entryCount || a.name.localeCompare(b.name));
  return { kinds };
}

/** PATCH /v1/kb/kinds: rename `from`; merges when `to` already exists. Legacy codes count as their Chinese name. */
export function renameKbKind(db: DatabaseSync, { from, to }: KbKindRename, now: string): { updated: number } {
  if (from === to) return { updated: 0 };
  const ids = loadAliveEntries(db)
    .filter((row) => normalizeKind(row.kind) === from)
    .map((row) => row.id);
  const result = db.prepare("UPDATE kb_entries SET kind = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))").run(to, now, JSON.stringify(ids));
  return { updated: Number(result.changes) };
}
