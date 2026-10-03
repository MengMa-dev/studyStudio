import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_API, DATA_API, HOME_API, INBOX_API, KB_API, NOTES_API, ORGANIZE_API, TIMELINE_API, TRASH_API } from "@study-studio/shared";
import { openDatabase } from "../src/db/database.js";
import { PresenceStore } from "../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../src/http/app.js";

const contractRoutes: Array<[method: string, path: string]> = [
  ["GET", HOME_API.summary],
  ["GET", INBOX_API.list],
  ["GET", `${INBOX_API.impact}?ids=a`],
  ["POST", INBOX_API.bulk],
  ["GET", INBOX_API.detail("item-1")],
  ["PATCH", INBOX_API.patch("item-1")],
  ["DELETE", INBOX_API.delete],
  ["GET", NOTES_API.list],
  ["POST", NOTES_API.create],
  ["PATCH", NOTES_API.patch("note-1")],
  ["DELETE", NOTES_API.delete("note-1")],
  ["GET", TIMELINE_API.timeline],
  ["GET", TIMELINE_API.overview],
  ["GET", TRASH_API.list],
  ["POST", TRASH_API.restore("trash-1")],
  ["DELETE", TRASH_API.purge("trash-1")],
  ["GET", DATA_API.info],
  ["POST", DATA_API.export],
  ["POST", DATA_API.import],
  ["POST", DATA_API.reindex],
  ["POST", DATA_API.reveal],
  ["POST", DATA_API.wipe],
  ["POST", DATA_API.pairingReset],
  ["GET", DATA_API.learnerProfile],
  ["PUT", DATA_API.learnerProfile],
  ["GET", DATA_API.onboarding],
  ["POST", DATA_API.onboarding],
  ["GET", AI_API.providers],
  ["POST", AI_API.providers],
  ["PATCH", AI_API.provider("p-1")],
  ["DELETE", AI_API.provider("p-1")],
  ["POST", AI_API.testProvider("p-1")],
  ["GET", AI_API.tasks],
  ["PUT", AI_API.tasks],
  ["GET", `${AI_API.usage}?day=2026-10-03`],
  ["PUT", AI_API.limits],
  ["GET", ORGANIZE_API.settings],
  ["PUT", ORGANIZE_API.settings],
  ["POST", ORGANIZE_API.preview],
  ["POST", ORGANIZE_API.run],
  ["GET", ORGANIZE_API.runs],
  ["GET", ORGANIZE_API.runDetail("run-1")],
  ["POST", ORGANIZE_API.retry("run-1")],
  ["GET", ORGANIZE_API.events],
  ["GET", KB_API.tree],
  ["GET", `${KB_API.impact}?ids=a`],
  ["GET", KB_API.entry("kb-1")],
  ["PATCH", KB_API.patch("kb-1")],
  ["DELETE", KB_API.delete]
];

function firstMatchingRoute(routes: Array<{ method: string; path: string }>, method: string, path: string): string | null {
  const pathname = path.split("?")[0]!;
  for (const route of routes) {
    if (route.method !== method || route.path.includes("*")) continue;
    const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, "[^/]+")}$`);
    if (pattern.test(pathname)) return route.path;
  }
  return null;
}

test("every shared contract path is routed, static segments before :id", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-routes-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const appDb = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(() => appDb.close());
  const port = 43118;
  const app = createApp({
    appDb,
    auth: createAuthState("tok", port),
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: join(dataDir, "missing-dist")
  });

  for (const [method, path] of contractRoutes) {
    assert.ok(firstMatchingRoute(app.routes, method, path), `${method} ${path} is not routed`);
  }
  assert.equal(firstMatchingRoute(app.routes, "GET", INBOX_API.impact), INBOX_API.impact);
  assert.equal(firstMatchingRoute(app.routes, "GET", KB_API.impact), KB_API.impact);

  const skeleton = await app.request(`http://127.0.0.1:${port}${KB_API.tree}`, {
    headers: { host: `127.0.0.1:${port}`, authorization: "Bearer tok" }
  });
  assert.ok(skeleton.status === 501 || skeleton.status === 200);
});
