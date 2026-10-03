import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ACTIVITY_EVENT_TYPES } from "@study-studio/shared";
import type { TrashRow } from "../../db/types.js";
import { getStoredCollectorSettings } from "../settings/settings.js";
import { ITEM_TRASH_KINDS, purgeItemTrash } from "../trash/items.js";
import { getTrashHandler } from "../trash/registry.js";
import { toTrashRecord } from "../trash/store.js";

const ACTIVITY_TYPES = [...ACTIVITY_EVENT_TYPES];

/** Physically delete the entities behind expired trash rows, drop the rows, then unreferenced blobs. */
export function purgeExpiredTrash(db: DatabaseSync, dataDir: string | null, now = new Date()): number {
  const nowIso = now.toISOString();
  const expired = db.prepare("SELECT * FROM trash WHERE expires_at IS NOT NULL AND expires_at <= ?").all(nowIso) as TrashRow[];
  const del = db.prepare("DELETE FROM trash WHERE id = ?");
  for (const row of expired) {
    const record = toTrashRecord(row);
    try {
      if (ITEM_TRASH_KINDS.has(record.kind)) {
        purgeItemTrash(db, record);
      } else {
        const pending = getTrashHandler(record.kind)?.purge({ db, dataDir }, record);
        if (pending) {
          void pending.then(() => del.run(row.id)).catch(() => {});
          continue;
        }
      }
    } catch {
      continue;
    }
    del.run(row.id);
  }
  if (dataDir) cleanupOrphanBlobs(db, dataDir);
  return expired.length;
}

/** Remove activity events older than retentionDays (default 14). Content events are kept. */
export function purgeExpiredActivityEvents(db: DatabaseSync, now = new Date()): number {
  const { activityTracking } = getStoredCollectorSettings(db);
  const cutoff = new Date(now.getTime() - activityTracking.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = ACTIVITY_TYPES.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM events WHERE type IN (${placeholders}) AND occurred_at < ?`).run(...ACTIVITY_TYPES, cutoff);
  return Number(result.changes);
}

function referencedSha256(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT sha256 FROM assets WHERE sha256 IS NOT NULL").all() as { sha256: string }[];
  return new Set(rows.map((row) => row.sha256));
}

export function cleanupOrphanBlobs(db: DatabaseSync, dataDir: string): number {
  const blobsRoot = join(dataDir, "blobs");
  let removed = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(blobsRoot);
  } catch {
    return 0;
  }
  const keep = referencedSha256(db);
  for (const prefix of dirs) {
    const dir = join(blobsRoot, prefix);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (keep.has(file)) continue;
      try {
        unlinkSync(join(dir, file));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
