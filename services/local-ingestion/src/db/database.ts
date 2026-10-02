import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export type AppDatabase = {
  db: DatabaseSync;
  dataDir: string | null;
  vectorEnabled: boolean;
  close(): void;
};

export type OpenDatabaseOptions = {
  /** Absolute data directory; ignored when `memory` is true. */
  dataDir?: string;
  /** Use an in-memory database (tests). */
  memory?: boolean;
  /** Skip loading sqlite-vec (tests / degraded environments). */
  skipVector?: boolean;
};

function applyPragmas(db: DatabaseSync, memory: boolean): void {
  if (!memory) db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
}

function quickCheck(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
  if (!row || row.quick_check !== "ok") {
    throw new Error(`SQLite quick_check failed: ${row?.quick_check ?? "no result"}. Restore from backups/ if needed.`);
  }
}

function listMigrationFiles(): { version: number; path: string; sql: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  return files.map((name) => {
    const version = Number(name.slice(0, 3));
    const path = join(MIGRATIONS_DIR, name);
    return { version, path, sql: readFileSync(path, "utf8") };
  });
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((row) => row.version));
  const insert = db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  for (const migration of listMigrationFiles()) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      insert.run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function loadSqliteVec(db: DatabaseSync): boolean {
  try {
    db.loadExtension(getLoadablePath());
    db.prepare("SELECT vec_version() AS version").get();
    return true;
  } catch {
    return false;
  }
}

export function openDatabase(options: OpenDatabaseOptions = {}): AppDatabase {
  const memory = Boolean(options.memory);
  const dataDir = options.dataDir ?? null;
  let dbPath = ":memory:";

  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    mkdirSync(join(dataDir, "backups"), { recursive: true });
  }

  if (!memory) {
    if (!dataDir) throw new Error("dataDir is required unless memory=true");
    dbPath = join(dataDir, "studystudio.db");
  }

  const db = new DatabaseSync(dbPath, { allowExtension: true });
  applyPragmas(db, memory);
  if (!memory) quickCheck(db);
  runMigrations(db);
  const vectorEnabled = options.skipVector ? false : loadSqliteVec(db);

  return {
    db,
    dataDir,
    vectorEnabled,
    close() {
      if (!memory) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          /* ignore on close */
        }
      }
      db.close();
    }
  };
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}
