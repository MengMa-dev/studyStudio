import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { startScheduler } from "../src/jobs/scheduler.js";
import { purgeExpiredActivityEvents } from "../src/domains/data/cleanup.js";

test("database applies migrations in order", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-db-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = openDatabase({ dataDir, skipVector: true });
  t.after(() => app.close());

  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  assert.ok(tables.includes("events"));
  assert.ok(tables.includes("items"));
  assert.ok(tables.includes("item_exposure"));
  assert.ok(tables.includes("schema_migrations"));
  assert.ok(tables.includes("chat_messages"));
  assert.ok(tables.includes("chunks"));
  assert.ok(!tables.includes("chunks_vec"), "vec0 table is created by code after loading sqlite-vec");
  const versions = (app.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4]);
  const entryColumns = (app.db.prepare("PRAGMA table_info(kb_entries)").all() as { name: string }[]).map((row) => row.name);
  assert.ok(entryColumns.includes("dirty"));
  const runColumns = (app.db.prepare("PRAGMA table_info(organize_runs)").all() as { name: string }[]).map((row) => row.name);
  assert.ok(runColumns.includes("scope_ids") && runColumns.includes("progress"));
});

test("scheduler backup creates a VACUUM INTO file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-bak-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = openDatabase({ dataDir, skipVector: true });
  const scheduler = startScheduler(app.db, dataDir);
  t.after(() => {
    scheduler.stop();
    app.close();
  });
  const path = scheduler.runBackupNow();
  assert.ok(path);
  const files = await readdir(join(dataDir, "backups"));
  assert.ok(files.some((name) => name.startsWith("studystudio-") && name.endsWith(".db")));
});

test("activity event retention purge", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-purge-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = openDatabase({ dataDir, skipVector: true, memory: true });
  t.after(() => app.close());

  app.db
    .prepare(
      `INSERT INTO events(id, type, occurred_at, day, channel, site, url, canonical_url, session_id, item_id, payload, received_at)
       VALUES (?, 'page_session', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, '{}', ?)`
    )
    .run("old-session-1", "2020-01-01T00:00:00.000Z", "2020-01-01", "2020-01-01T00:00:00.000Z");
  app.db
    .prepare(
      `INSERT INTO events(id, type, occurred_at, day, channel, site, url, canonical_url, session_id, item_id, payload, received_at)
       VALUES (?, 'webpage_captured', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, '{}', ?)`
    )
    .run("keep-page-1", "2020-01-01T00:00:00.000Z", "2020-01-01", "2020-01-01T00:00:00.000Z");

  const removed = purgeExpiredActivityEvents(app.db, new Date("2026-10-02T00:00:00.000Z"));
  assert.equal(removed, 1);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 1);
});
