import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ACTIVITY_EVENT_TYPES } from "@study-studio/shared";
import { getStoredCollectorSettings } from "../settings/settings.js";

const ACTIVITY_TYPES = [...ACTIVITY_EVENT_TYPES];

/** Delete expired trash rows and unreferenced blobs. */
export function purgeExpiredTrash(db: DatabaseSync, dataDir: string | null, now = new Date()): number {
  const nowIso = now.toISOString();
  const expired = db.prepare("SELECT id, snapshot FROM trash WHERE expires_at IS NOT NULL AND expires_at <= ?").all(nowIso) as {
    id: string;
    snapshot: string | null;
  }[];
  const del = db.prepare("DELETE FROM trash WHERE id = ?");
  for (const row of expired) {
    del.run(row.id);
    // Physical cleanup of soft-deleted entities is deferred to a fuller wipe path in M3;
    // here we only drop the trash snapshot rows that have expired.
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
