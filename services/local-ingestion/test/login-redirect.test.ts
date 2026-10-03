import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/database.js";
import { PresenceStore } from "../src/domains/capture/presence.js";
import { createApp, createAuthState, createLoginLink } from "../src/http/app.js";

const port = 43121;

function setup(workbenchUrl?: string) {
  const appDb = openDatabase({ dataDir: "/tmp", memory: true, skipVector: true });
  const auth = createAuthState("tok", port);
  const app = createApp({
    appDb,
    auth,
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: "/nonexistent",
    ...(workbenchUrl ? { workbenchUrl } : {})
  });
  const login = async () => {
    const link = new URL(createLoginLink(auth, port));
    return app.request(`http://127.0.0.1:${port}${link.pathname}${link.search}`, { headers: { host: `127.0.0.1:${port}` } });
  };
  return { appDb, login };
}

test("login redirects to the bundled workbench by default", async (t) => {
  const { appDb, login } = setup();
  t.after(() => appDb.close());
  const res = await login();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/app/");
  assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/i);
});

test("login redirects to the dev workbench when configured", async (t) => {
  const { appDb, login } = setup("http://127.0.0.1:5173/app/");
  t.after(() => appDb.close());
  const res = await login();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://127.0.0.1:5173/app/");
});
