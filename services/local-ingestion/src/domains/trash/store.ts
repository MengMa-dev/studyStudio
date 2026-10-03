import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TrashEntry } from "@study-studio/shared";
import type { TrashRow } from "../../db/types.js";
import { parseJson } from "../inbox/sql.js";
import type { TrashMeta, TrashRecord, TrashTargets } from "./registry.js";

export const TRASH_RETENTION_DAYS = 30;

type StoredSnapshot = { version?: number; meta?: Partial<TrashMeta>; payload?: unknown };

export type InsertTrashInput = {
  kind: string;
  targets: Partial<TrashTargets>;
  meta: TrashMeta;
  payload: unknown;
  now?: Date;
};

/** Writes one trash row in the shared format (`target_ids` = TrashTargets, `snapshot` = { version, meta, payload }). */
export function insertTrashRow(db: DatabaseSync, input: InsertTrashInput): TrashRecord {
  const now = input.now ?? new Date();
  const record: TrashRecord = {
    id: randomUUID(),
    kind: input.kind,
    targets: { itemIds: input.targets.itemIds ?? [], noteIds: input.targets.noteIds ?? [], entryIds: input.targets.entryIds ?? [] },
    meta: input.meta,
    payload: input.payload,
    deletedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  };
  db.prepare("INSERT INTO trash(id, kind, target_ids, snapshot, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    record.id,
    record.kind,
    JSON.stringify(record.targets),
    JSON.stringify({ version: 1, meta: record.meta, payload: record.payload }),
    record.deletedAt,
    record.expiresAt
  );
  return record;
}

export function toTrashRecord(row: TrashRow): TrashRecord {
  const targets = parseJson<Partial<TrashTargets> | string[]>(row.target_ids, {});
  const normalized: TrashTargets = Array.isArray(targets)
    ? { itemIds: [], noteIds: [], entryIds: targets.filter((id) => typeof id === "string") }
    : { itemIds: targets.itemIds ?? [], noteIds: targets.noteIds ?? [], entryIds: targets.entryIds ?? [] };
  const snapshot = parseJson<StoredSnapshot>(row.snapshot, {});
  const meta = snapshot.meta ?? {};
  return {
    id: row.id,
    kind: row.kind ?? "items",
    targets: normalized,
    meta: {
      title: meta.title ?? "已删除内容",
      site: meta.site ?? null,
      itemType: meta.itemType ?? null,
      removeFromKb: meta.removeFromKb ?? false,
      removedEntryCount: meta.removedEntryCount ?? 0
    },
    payload: snapshot.payload ?? null,
    deletedAt: row.deleted_at ?? new Date(0).toISOString(),
    expiresAt: row.expires_at ?? row.deleted_at ?? new Date(0).toISOString()
  };
}

export function getTrashRecord(db: DatabaseSync, id: string): TrashRecord | null {
  const row = db.prepare("SELECT * FROM trash WHERE id = ?").get(id) as TrashRow | undefined;
  return row ? toTrashRecord(row) : null;
}

const TRASH_KINDS = new Set<TrashEntry["kind"]>(["items", "notes", "mixed", "entries"]);

export function listTrash(db: DatabaseSync): TrashEntry[] {
  const rows = db.prepare("SELECT * FROM trash ORDER BY deleted_at DESC, id DESC").all() as TrashRow[];
  return rows
    .map(toTrashRecord)
    .filter((record) => TRASH_KINDS.has(record.kind as TrashEntry["kind"]))
    .map((record) => ({
      id: record.id,
      kind: record.kind as TrashEntry["kind"],
      title: record.meta.title,
      site: record.meta.site,
      itemType: record.meta.itemType,
      deletedAt: record.deletedAt,
      expiresAt: record.expiresAt,
      removeFromKb: record.meta.removeFromKb,
      removedEntryCount: record.meta.removedEntryCount,
      itemIds: record.targets.itemIds,
      noteIds: record.targets.noteIds,
      entryIds: record.targets.entryIds
    }));
}
