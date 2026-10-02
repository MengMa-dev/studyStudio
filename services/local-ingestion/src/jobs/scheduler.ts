import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import type { DatabaseSync } from "node:sqlite";
import { purgeExpiredActivityEvents, purgeExpiredTrash } from "../domains/data/cleanup.js";

export type Scheduler = {
  stop(): void;
  runBackupNow(): string | null;
  runCleanupNow(): { trash: number; activity: number };
};

function listBackups(backupsDir: string): string[] {
  try {
    return readdirSync(backupsDir)
      .filter((name) => /^studystudio-\d{8}\.db$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function pruneBackups(backupsDir: string, keep = 7): void {
  const files = listBackups(backupsDir);
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const name of excess) {
    try {
      unlinkSync(join(backupsDir, name));
    } catch {
      /* ignore */
    }
  }
}

function todayStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Daily VACUUM INTO backups/, keep 7 copies. No-op for in-memory databases. */
export function runDailyBackup(db: DatabaseSync, dataDir: string | null): string | null {
  if (!dataDir) return null;
  const backupsDir = join(dataDir, "backups");
  const target = join(backupsDir, `studystudio-${todayStamp()}.db`);
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } catch (error) {
    // If today's backup already exists, SQLite rejects overwrite — treat as success.
    if (error instanceof Error && /already exists|file exists/i.test(error.message)) {
      pruneBackups(backupsDir);
      return target;
    }
    throw error;
  }
  pruneBackups(backupsDir);
  return target;
}

export function startScheduler(db: DatabaseSync, dataDir: string | null): Scheduler {
  const jobs: Cron[] = [];

  // Daily backup at 03:00 local time.
  jobs.push(
    new Cron("0 3 * * *", { protect: true }, () => {
      try {
        runDailyBackup(db, dataDir);
      } catch (error) {
        console.error("[scheduler] backup failed:", error instanceof Error ? error.message : error);
      }
    })
  );

  // Trash + activity log cleanup every hour.
  jobs.push(
    new Cron("15 * * * *", { protect: true }, () => {
      try {
        purgeExpiredTrash(db, dataDir);
        purgeExpiredActivityEvents(db);
      } catch (error) {
        console.error("[scheduler] cleanup failed:", error instanceof Error ? error.message : error);
      }
    })
  );

  // Also take a backup on first start of the day if missing.
  try {
    if (dataDir) {
      const existing = listBackups(join(dataDir, "backups"));
      if (!existing.includes(`studystudio-${todayStamp()}.db`)) runDailyBackup(db, dataDir);
    }
  } catch (error) {
    console.error("[scheduler] startup backup failed:", error instanceof Error ? error.message : error);
  }

  return {
    stop() {
      for (const job of jobs) job.stop();
    },
    runBackupNow() {
      return runDailyBackup(db, dataDir);
    },
    runCleanupNow() {
      return {
        trash: purgeExpiredTrash(db, dataDir),
        activity: purgeExpiredActivityEvents(db)
      };
    }
  };
}
