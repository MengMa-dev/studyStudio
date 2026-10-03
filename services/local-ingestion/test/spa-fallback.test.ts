import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { PresenceStore } from "../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../src/http/app.js";

const port = 43120;

test("client-side routes under /app fall back to index.html; missing assets stay 404", async (t) => {
  const dist = await mkdtemp(join(tmpdir(), "study-studio-dist-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "assets", "app.js"), "console.log(1)");

  const appDb = openDatabase({ dataDir: dist, memory: true, skipVector: true });
  t.after(() => appDb.close());
  const app = createApp({
    appDb,
    auth: createAuthState("tok", port),
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: dist
  });
  const get = (path: string) => app.request(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });

  for (const path of ["/app/", "/app/inbox", "/app/wiki/kb-1"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /id=root/);
  }
  assert.equal(await (await get("/app/assets/app.js")).text(), "console.log(1)");
  assert.equal((await get("/app/assets/missing.js")).status, 404);
});
