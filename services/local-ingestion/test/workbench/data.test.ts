import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_API,
  dataExportResponseSchema,
  dataImportResponseSchema,
  dataInfoResponseSchema,
  dataReindexResponseSchema,
  dataRevealResponseSchema,
  dataWipeResponseSchema,
  learnerProfileResponseSchema,
  onboardingStatusSchema,
  pairingResetResponseSchema
} from "@study-studio/shared";
import { setRevealLauncher } from "../../src/domains/data/reveal.js";
import { readZip } from "../../src/domains/data/zip.js";
import { setup, TOKEN } from "./helpers.js";

test("data info, learner profile, onboarding, reveal and reindex", async (t) => {
  const { call, page, presence } = await setup(t);
  page("https://docs.example.com/a", "A", "2026-10-01T02:00:00.000Z");

  const info = dataInfoResponseSchema.parse((await call("GET", DATA_API.info)).body);
  assert.equal(info.address, "127.0.0.1:43118");
  assert.equal(info.itemCount, 1);
  assert.match(info.sqliteVersion, /^\d+\.\d+/);
  assert.equal(info.pairingToken, TOKEN);
  assert.equal(info.pairingTokenMasked, "••••••••");
  assert.equal(info.extensionConnected, true, "the event just ingested counts as extension activity");

  const profile = { role: "产品经理", directions: [{ id: "d1", text: "Agent 架构", expiresAt: "2026-11-01" }] };
  assert.deepEqual(learnerProfileResponseSchema.parse((await call("GET", DATA_API.learnerProfile)).body).profile, { role: "", directions: [] });
  assert.deepEqual(learnerProfileResponseSchema.parse((await call("PUT", DATA_API.learnerProfile, profile)).body).profile, profile);
  assert.deepEqual(learnerProfileResponseSchema.parse((await call("GET", DATA_API.learnerProfile)).body).profile, profile);
  assert.equal((await call("PUT", DATA_API.learnerProfile, { role: "x", directions: [{ id: "d", text: "t", expiresAt: "soon" }] })).status, 422);

  const before = onboardingStatusSchema.parse((await call("GET", DATA_API.onboarding)).body);
  assert.deepEqual(before, { needsOnboarding: true, pairingToken: TOKEN, extensionConnected: true });
  assert.equal(onboardingStatusSchema.parse((await call("POST", DATA_API.onboarding)).body).needsOnboarding, false);
  assert.equal(onboardingStatusSchema.parse((await call("GET", DATA_API.onboarding)).body).needsOnboarding, false);

  const revealed: string[] = [];
  t.after(setRevealLauncher((path) => revealed.push(path)));
  dataRevealResponseSchema.parse((await call("POST", DATA_API.reveal)).body);
  assert.equal(revealed.length, 1);

  const reindex = dataReindexResponseSchema.parse((await call("POST", DATA_API.reindex)).body);
  assert.equal(reindex.status, "done", "no search index configured → nothing to rebuild");
  presence.clear();
});

test("pairing reset invalidates the old token", async (t) => {
  const { call, dataDir } = await setup(t);
  const reset = pairingResetResponseSchema.parse((await call("POST", DATA_API.pairingReset)).body);
  assert.notEqual(reset.token, TOKEN);
  assert.ok(reset.masked.endsWith(reset.token.slice(-4)));
  assert.equal(readFileSync(join(dataDir, ".pairing-token"), "utf8"), reset.token);
  assert.equal((await call("GET", DATA_API.info, undefined, { token: TOKEN })).status, 401);
  assert.equal((await call("GET", DATA_API.info, undefined, { token: reset.token })).status, 200);
});

test("export, wipe and import round-trip business data and blobs", async (t) => {
  const { call, db, dataDir, page, note } = await setup(t);
  const itemId = page("https://docs.example.com/a", "A", "2026-10-01T02:00:00.000Z");
  page("https://docs.example.com/b", "B", "2026-10-01T03:00:00.000Z");
  note("模糊备注", "2026-10-01T04:00:00.000Z");
  const blobSha = "ab".padEnd(64, "0");
  mkdirSync(join(dataDir, "blobs", "ab"), { recursive: true });
  writeFileSync(join(dataDir, "blobs", "ab", blobSha), "image-bytes");
  db.prepare("INSERT INTO assets(id, item_id, kind, sha256, mime, size) VALUES ('a1', ?, 'image', ?, 'image/png', 11)").run(itemId, blobSha);
  writeFileSync(join(dataDir, "secrets.json"), "{}");

  const exported = dataExportResponseSchema.parse((await call("POST", DATA_API.export)).body);
  const zipPath = join(dataDir, "exports", exported.filename);
  assert.ok(existsSync(zipPath));
  const names = readZip(readFileSync(zipPath)).map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["blobs/ab/" + blobSha, "manifest.json", "studystudio.db"].sort(), "secrets.json is never exported");

  assert.equal((await call("POST", DATA_API.wipe, { confirm: "yes" })).status, 422);
  const wiped = dataWipeResponseSchema.parse((await call("POST", DATA_API.wipe, { confirm: "清空" })).body);
  assert.ok(wiped.backupFilename && existsSync(join(dataDir, "backups", wiped.backupFilename)));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 0);
  assert.ok(db.prepare("SELECT 1 FROM settings WHERE key = 'collector'").get(), "settings survive a wipe");
  assert.ok(!existsSync(join(dataDir, "blobs", "ab", blobSha)));

  const imported = dataImportResponseSchema.parse((await call("POST", DATA_API.import, { filename: exported.filename })).body);
  assert.deepEqual(imported, { ok: true, itemCount: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 1);
  assert.equal(readFileSync(join(dataDir, "blobs", "ab", blobSha), "utf8"), "image-bytes");

  await call("POST", DATA_API.wipe, { confirm: "清空" });
  const raw = dataImportResponseSchema.parse((await call("POST", DATA_API.import, readFileSync(zipPath))).body);
  assert.equal(raw.itemCount, 2, "the zip can also be uploaded as the request body");

  assert.equal((await call("POST", DATA_API.import, Buffer.from("not a zip"))).status, 422);
  assert.equal((await call("POST", DATA_API.import, { filename: "../../etc/passwd" })).status, 404);
  assert.equal((await call("POST", DATA_API.import)).status, 400);
});
