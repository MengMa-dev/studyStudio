import type { DatabaseSync } from "node:sqlite";
import {
  LEGACY_KIND_NAMES,
  OTHER_KIND,
  kbRelationTypeSchema,
  kbSourceKindSchema,
  type KbEntryKind,
  type KbRelationType,
  type KbSourceKind
} from "@study-studio/shared";
import type { KbCategoryRow, KbEntryRow } from "../../db/types.js";
import { EMPTY_MASTERY_SIGNALS, effectiveMastery, type MasterySignals } from "./mastery.js";

export const UNCATEGORIZED_NAME = "未分类";

export const ENTRY_COLUMNS = [
  "id",
  "name",
  "category_id",
  "kind",
  "aliases",
  "summary",
  "body_markdown",
  "completeness",
  "mastery",
  "mastery_source",
  "user_edited",
  "stale",
  "orphan",
  "patch_count",
  "dirty",
  "updated_at",
  "deleted_at"
] as const satisfies readonly (keyof KbEntryRow)[];

const ENTRY_SELECT = `SELECT ${ENTRY_COLUMNS.join(", ")} FROM kb_entries`;

export function normalizeKind(kind: string | null): KbEntryKind {
  if (!kind?.trim()) return OTHER_KIND;
  return Object.hasOwn(LEGACY_KIND_NAMES, kind) ? LEGACY_KIND_NAMES[kind]! : kind;
}

export function normalizeSourceKind(kind: string | null): KbSourceKind {
  const parsed = kbSourceKindSchema.safeParse(kind);
  return parsed.success ? parsed.data : "other";
}

export function parseRelationType(type: string): KbRelationType | null {
  const parsed = kbRelationTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : null;
}

export function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseAliases(value: string | null): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((alias): alias is string => typeof alias === "string") : [];
}

export function loadAliveEntries(db: DatabaseSync, ids?: readonly string[]): KbEntryRow[] {
  if (ids) {
    return db.prepare(`${ENTRY_SELECT} WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as KbEntryRow[];
  }
  return db.prepare(`${ENTRY_SELECT} WHERE deleted_at IS NULL`).all() as KbEntryRow[];
}

export function loadAliveEntry(db: DatabaseSync, id: string): KbEntryRow | null {
  return (db.prepare(`${ENTRY_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as KbEntryRow | undefined) ?? null;
}

export function loadCategories(db: DatabaseSync): Map<string, KbCategoryRow> {
  const rows = db.prepare("SELECT id, name, description, sort FROM kb_categories ORDER BY sort IS NULL, sort, name, id").all() as KbCategoryRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** Mastery inputs for every live entry that has signals; others get {@link EMPTY_MASTERY_SIGNALS}. */
export function loadMasterySignals(db: DatabaseSync): Map<string, MasterySignals> {
  const signals = new Map<string, MasterySignals>();
  const sourceRows = db
    .prepare(
      `SELECT s.entry_id AS entry_id,
              COUNT(*) AS source_count,
              COALESCE(SUM(i.reading_total_seconds), 0) AS reading_seconds,
              SUM(CASE WHEN i.type = 'conversation' THEN 1 ELSE 0 END) AS qa_count,
              SUM((SELECT COUNT(*) FROM notes n WHERE n.scope = 'item' AND n.target_id = i.id AND n.deleted_at IS NULL)) AS item_note_count
         FROM kb_entry_sources s
         JOIN items i ON i.id = s.item_id AND i.deleted_at IS NULL
        GROUP BY s.entry_id`
    )
    .all() as { entry_id: string; source_count: number; reading_seconds: number; qa_count: number; item_note_count: number }[];
  for (const row of sourceRows) {
    signals.set(row.entry_id, {
      sourceCount: Number(row.source_count),
      readingSeconds: Number(row.reading_seconds),
      qaCount: Number(row.qa_count),
      noteCount: Number(row.item_note_count)
    });
  }
  const noteRows = db
    .prepare("SELECT target_id, COUNT(*) AS n FROM notes WHERE scope = 'entry' AND deleted_at IS NULL AND target_id IS NOT NULL GROUP BY target_id")
    .all() as { target_id: string; n: number }[];
  for (const row of noteRows) {
    const current = signals.get(row.target_id) ?? { ...EMPTY_MASTERY_SIGNALS };
    signals.set(row.target_id, { ...current, noteCount: current.noteCount + Number(row.n) });
  }
  return signals;
}

export function signalsOf(signals: Map<string, MasterySignals>, id: string): MasterySignals {
  return signals.get(id) ?? EMPTY_MASTERY_SIGNALS;
}

export function masteryOf(row: Pick<KbEntryRow, "id" | "mastery" | "mastery_source">, signals: Map<string, MasterySignals>): number | null {
  return effectiveMastery(row.mastery, row.mastery_source, signalsOf(signals, row.id));
}

export type TreeLayout = Map<string, { parentId: string | null; depth: number }>;

/**
 * Directory nesting from `part_of` edges (`src` part_of `dst` → `dst` is the parent).
 * A child nests only under a live parent in the same category; with several parents the smallest id wins.
 * Entries stuck in a `part_of` cycle (unreachable from any root) fall back to roots.
 */
export function loadTreeLayout(db: DatabaseSync): TreeLayout {
  const rows = db
    .prepare(
      `WITH RECURSIVE
         alive AS (SELECT id, category_id FROM kb_entries WHERE deleted_at IS NULL),
         parent AS (
           SELECT e.src AS child, MIN(e.dst) AS parent_id
             FROM kb_edges e
             JOIN alive c ON c.id = e.src
             JOIN alive p ON p.id = e.dst
            WHERE e.type = 'part_of' AND e.src <> e.dst AND c.category_id IS p.category_id
            GROUP BY e.src
         ),
         tree(id, parent_id, depth, path) AS (
           SELECT a.id, NULL, 0, char(31) || a.id || char(31)
             FROM alive a
            WHERE a.id NOT IN (SELECT child FROM parent)
           UNION ALL
           SELECT p.child, p.parent_id, t.depth + 1, t.path || p.child || char(31)
             FROM parent p
             JOIN tree t ON p.parent_id = t.id
            WHERE instr(t.path, char(31) || p.child || char(31)) = 0
         )
       SELECT id, parent_id, depth FROM tree`
    )
    .all() as { id: string; parent_id: string | null; depth: number }[];
  const layout: TreeLayout = new Map();
  for (const row of rows) layout.set(row.id, { parentId: row.parent_id, depth: Number(row.depth) });
  return layout;
}

export function parentOf(layout: TreeLayout, id: string): string | null {
  return layout.get(id)?.parentId ?? null;
}

export function countAliveSources(db: DatabaseSync, entryId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM kb_entry_sources s JOIN items i ON i.id = s.item_id AND i.deleted_at IS NULL WHERE s.entry_id = ?")
    .get(entryId) as { n: number };
  return Number(row.n);
}
