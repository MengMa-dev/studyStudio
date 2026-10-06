import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { PresenceStore } from "../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../src/http/app.js";
import { consumeLoginCode, createSession, writeLoginCode } from "../src/http/auth.js";
import { SKILL_MARKDOWN } from "../src/domains/agent/skill.js";

test("sessions survive restart; CLI login codes are one-time", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-sess-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const session = createSession(createAuthState("tok", 1, "mcp", dataDir));
  assert.ok(createAuthState("tok", 1, "mcp", dataDir).sessions.has(session));

  const auth = createAuthState("tok", 1, "mcp", dataDir);
  const code = writeLoginCode(dataDir);
  assert.equal(consumeLoginCode(auth, "wrong"), false);
  assert.equal(consumeLoginCode(auth, code), true);
  assert.equal(consumeLoginCode(auth, code), false);
});

test("skills/organize-kb/SKILL.md matches SKILL_MARKDOWN", () => {
  const file = readFileSync(new URL("../../../skills/organize-kb/SKILL.md", import.meta.url), "utf8");
  assert.equal(file, SKILL_MARKDOWN, "regenerate skills/organize-kb/SKILL.md from domains/agent/skill.ts");
});

test("Host header DNS rebinding guard", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-host-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const appDb = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(() => appDb.close());
  const port = 43118;
  const auth = createAuthState("tok", port);
  const app = createApp({
    appDb,
    auth,
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: join(dataDir, "missing-dist")
  });

  const ok = await app.request("http://127.0.0.1:43118/health", { headers: { host: "127.0.0.1:43118" } });
  assert.equal(ok.status, 200);

  const bad = await app.request("http://127.0.0.1:43118/health", { headers: { host: "evil.example:43118" } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_host" });
});

test("Origin guard rejects cross-origin writes for cookie sessions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-origin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const appDb = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(() => appDb.close());
  const port = 43118;
  const auth = createAuthState("tok", port);
  auth.sessions.add("sess");
  const app = createApp({
    appDb,
    auth,
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: join(dataDir, "missing-dist")
  });

  const cross = await app.request("http://127.0.0.1:43118/v1/settings", {
    method: "PUT",
    headers: {
      host: "127.0.0.1:43118",
      origin: "http://evil.example",
      cookie: "ss_session=sess",
      "content-type": "application/json"
    },
    body: JSON.stringify({ captureRules: { preset: "debug" } })
  });
  assert.equal(cross.status, 403);

  const same = await app.request("http://127.0.0.1:43118/v1/settings", {
    method: "PUT",
    headers: {
      host: "127.0.0.1:43118",
      origin: "http://127.0.0.1:43118",
      cookie: "ss_session=sess",
      "content-type": "application/json"
    },
    body: JSON.stringify({ captureRules: { preset: "debug" } })
  });
  assert.equal(same.status, 200);
});
