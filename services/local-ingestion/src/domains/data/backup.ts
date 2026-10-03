import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../../db/database.js";
import { InvalidZipError, readZip, ZipWriter } from "./zip.js";

export const BACKUP_FORMAT = "study-studio-backup";
const DB_ENTRY = "studystudio.db";
const MANIFEST_ENTRY = "manifest.json";
const BLOB_ENTRY = /^blobs\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

/** Business data removed by wipe / replaced by import. Config (settings, rules, providers, task_models) survives a wipe. */
const BUSINESS_TABLES = [
  "item_contents",
  "reading_sessions",
  "item_exposure",
  "assets",
  "tags",
  "notes",
  "events",
  "items",
  "kb_categories",
  "kb_entries",
  "kb_edges",
  "kb_edge_sources",
  "kb_entry_sources",
  "kb_ignore",
  "organize_results",
  "episodes",
  "episode_items",
  "organize_runs",
  "organize_jobs",
  "trash",
  "usage_daily",
  "chat_messages"
];

export class DataDirRequiredError extends Error {
  constructor() {
    super("data directory is not available");
    this.name = "DataDirRequiredError";
  }
}

export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBackupError";
  }
}

export function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
  return Number(row?.v ?? 0);
}

function listBlobFiles(dataDir: string): { name: string; path: string }[] {
  const root = join(dataDir, "blobs");
  const out: { name: string; path: string }[] = [];
  let prefixes: string[];
  try {
    prefixes = readdirSync(root);
  } catch {
    return out;
  }
  for (const prefix of prefixes) {
    const dir = join(root, prefix);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        const name = `blobs/${prefix}/${file}`;
        if (BLOB_ENTRY.test(name)) out.push({ name, path: join(dir, file) });
      }
    } catch {
      continue;
    }
  }
  return out;
}

export function exportsDir(dataDir: string): string {
  return join(dataDir, "exports");
}

/** `VACUUM INTO` snapshot + blobs/ zipped into `<dataDir>/exports/`. `secrets.json` is never included. */
export function exportBackup(appDb: AppDatabase, now = new Date()): { filename: string; sizeBytes: number; path: string } {
  if (!appDb.dataDir) throw new DataDirRequiredError();
  const dir = exportsDir(appDb.dataDir);
  mkdirSync(dir, { recursive: true });
  const filename = `studystudio-backup-${timestamp(now)}.zip`;
  const path = join(dir, filename);
  const snapshot = join(dir, `.snapshot-${randomUUID()}.db`);
  try {
    appDb.db.exec(`VACUUM INTO ${sqlString(snapshot)}`);
    const zip = new ZipWriter(path);
    try {
      zip.add(
        MANIFEST_ENTRY,
        Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: 1, schemaVersion: schemaVersion(appDb.db), exportedAt: now.toISOString() }))
      );
      zip.add(DB_ENTRY, readFileSync(snapshot), now);
      for (const blob of listBlobFiles(appDb.dataDir)) zip.add(blob.name, readFileSync(blob.path));
    } finally {
      zip.close();
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(snapshot, { force: true });
  }
  return { filename, sizeBytes: statSync(path).size, path };
}

function tablesOf(db: DatabaseSync, schema: "main" | "imp"): Map<string, string[]> {
  const tables = db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
       AND name NOT LIKE 'chunks%' AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL%')`
    )
    .all() as { name: string }[];
  const map = new Map<string, string[]>();
  for (const { name } of tables) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(name, schema) as { name: string }[];
    map.set(
      name,
      columns.map((column) => column.name)
    );
  }
  return map;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function validateSnapshot(path: string, currentVersion: number): void {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    const check = probe.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    if (check?.quick_check !== "ok") throw new InvalidBackupError("backup database failed integrity check");
    if (!probe.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()) {
      throw new InvalidBackupError("backup database has no items table");
    }
    const version = probe.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'schema_migrations'").get() ? schemaVersion(probe) : 0;
    if (version > currentVersion) throw new InvalidBackupError(`backup schema ${version} is newer than this app (${currentVersion})`);
  } catch (error) {
    if (error instanceof InvalidBackupError) throw error;
    throw new InvalidBackupError(`backup database is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    probe?.close();
  }
}

/** Writes a pre-change safety copy into backups/ and returns its file name (null without a data directory). */
export function safetyBackup(appDb: AppDatabase, label: string, now = new Date()): string | null {
  if (!appDb.dataDir) return null;
  const dir = join(appDb.dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const filename = `studystudio-${label}-${timestamp(now)}-${randomUUID().slice(0, 6)}.db`;
  appDb.db.exec(`VACUUM INTO ${sqlString(join(dir, filename))}`);
  return filename;
}

/**
 * Replaces all business data with the backup's content without reopening the connection:
 * the snapshot is attached and copied table by table (shared columns only) in one transaction.
 * Derived search tables are skipped; run reindex afterwards.
 */
export function importBackup(appDb: AppDatabase, archive: Buffer, now = new Date()): { itemCount: number; backupFilename: string | null } {
  let entries;
  try {
    entries = readZip(archive);
  } catch (error) {
    if (error instanceof InvalidZipError) throw new InvalidBackupError(error.message);
    throw error;
  }
  const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY);
  if (manifestEntry) {
    const manifest = JSON.parse(manifestEntry.read().toString("utf8")) as { format?: string };
    if (manifest.format !== BACKUP_FORMAT) throw new InvalidBackupError("not a Study Studio backup");
  }
  const dbEntry = entries.find((entry) => entry.name === DB_ENTRY);
  if (!dbEntry) throw new InvalidBackupError(`backup is missing ${DB_ENTRY}`);

  const workDir = appDb.dataDir ? join(appDb.dataDir, "exports") : tmpdir();
  mkdirSync(workDir, { recursive: true });
  const snapshot = join(workDir, `.import-${randomUUID()}.db`);
  writeFileSync(snapshot, dbEntry.read());
  const { db } = appDb;
  try {
    validateSnapshot(snapshot, schemaVersion(db));
    const backupFilename = safetyBackup(appDb, "preimport", now);
    db.exec(`ATTACH DATABASE ${sqlString(snapshot)} AS imp`);
    try {
      const main = tablesOf(db, "main");
      const imported = tablesOf(db, "imp");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("PRAGMA defer_foreign_keys = ON");
        for (const [table, columns] of main) {
          db.exec(`DELETE FROM main.${quoteIdent(table)}`);
          const source = imported.get(table);
          if (!source) continue;
          const shared = columns.filter((column) => source.includes(column)).map(quoteIdent);
          if (!shared.length) continue;
          db.exec(`INSERT INTO main.${quoteIdent(table)}(${shared.join(", ")}) SELECT ${shared.join(", ")} FROM imp.${quoteIdent(table)}`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.exec("DETACH DATABASE imp");
    }

    if (appDb.dataDir) {
      for (const entry of entries) {
        const match = BLOB_ENTRY.exec(entry.name);
        if (!match) continue;
        const dir = join(appDb.dataDir, "blobs", match[1]!);
        const target = join(dir, match[2]!);
        if (existsSync(target)) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, entry.read());
      }
    }
    const itemCount = Number((db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL").get() as { n: number }).n);
    return { itemCount, backupFilename };
  } finally {
    try {
      unlinkSync(snapshot);
    } catch {
      /* already gone */
    }
  }
}

/** Safety backup first, then every business table and all blobs are removed. */
export function wipeData(appDb: AppDatabase, now = new Date()): { backupFilename: string | null } {
  const backupFilename = safetyBackup(appDb, "wipe", now);
  const { db } = appDb;
  const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of BUSINESS_TABLES) if (existing.has(table)) db.exec(`DELETE FROM ${quoteIdent(table)}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (appDb.dataDir) {
    const blobs = join(appDb.dataDir, "blobs");
    rmSync(blobs, { recursive: true, force: true });
    mkdirSync(blobs, { recursive: true });
  }
  return { backupFilename };
}
