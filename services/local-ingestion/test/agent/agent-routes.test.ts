import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_API, agentConfigResponseSchema, agentSkillInstallResponseSchema } from "@study-studio/shared";
import { openDatabase } from "../../src/db/database.js";
import { PresenceStore } from "../../src/domains/capture/presence.js";
import { AGENT_SKILL_VERSION } from "../../src/domains/agent/tools.js";
import { createApp, createAuthState } from "../../src/http/app.js";

const port = 43119;

function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ss-agent-"));
  const homeDir = join(root, "home");
  const appDb = openDatabase({ dataDir: join(root, "data"), skipVector: true });
  t.after(() => {
    appDb.close();
    rmSync(root, { recursive: true, force: true });
  });
  const auth = createAuthState("tok", port, "mcp-old");
  auth.sessions.add("sess");
  const app = createApp({
    appDb,
    auth,
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: "/nonexistent-workbench-dist",
    homeDir
  });
  const call = async (method: string, path: string, body?: unknown, auth: Record<string, string> = { cookie: "ss_session=sess", origin: `http://127.0.0.1:${port}` }) => {
    const res = await app.request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}`, ...auth, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const mcp = (token: string) =>
    app.request(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
  return { root, homeDir, appDb, call, mcp };
}

test("config returns MCP url, token and skill version", async (t) => {
  const { call } = setup(t);
  assert.equal((await call("GET", AGENT_API.config, undefined, { authorization: "Bearer tok" })).status, 401, "pairing token cannot read the MCP token");
  const res = await call("GET", AGENT_API.config);
  assert.equal(res.status, 200);
  assert.deepEqual(agentConfigResponseSchema.parse(res.body), { url: `http://127.0.0.1:${port}/mcp`, token: "mcp-old", skillVersion: AGENT_SKILL_VERSION });
});

test("skill install writes SKILL.md under the home override", async (t) => {
  const { call, homeDir } = setup(t);
  const res = await call("POST", AGENT_API.skillInstall, { targets: ["cursor", "claude", "codex"] });
  assert.equal(res.status, 200);
  const { paths } = agentSkillInstallResponseSchema.parse(res.body);
  assert.deepEqual(
    paths,
    [".cursor", ".claude", ".codex"].map((dir) => join(homeDir, dir, "skills", "organize-kb", "SKILL.md"))
  );
  const text = readFileSync(paths[0]!, "utf8");
  assert.match(text, /^---\nname: organize-kb\n/);
  assert.match(text, new RegExp(`\\nskillVersion: ${AGENT_SKILL_VERSION}\\n`));
  assert.match(text, /get_guidelines/);
  assert.equal((await call("POST", AGENT_API.skillInstall, { targets: [] })).status, 422);
  assert.equal((await call("POST", AGENT_API.skillInstall, { targets: ["vscode"] })).status, 422);
});

test("token reset rotates the MCP token and the token file", async (t) => {
  const { call, mcp, appDb } = setup(t);
  assert.equal((await mcp("mcp-old")).status, 200);
  const res = await call("POST", AGENT_API.tokenReset);
  assert.equal(res.status, 200);
  const { token } = agentConfigResponseSchema.parse(res.body);
  assert.notEqual(token, "mcp-old");
  assert.equal((await mcp("mcp-old")).status, 401);
  assert.equal((await mcp(token)).status, 200);
  const file = join(appDb.dataDir!, "mcp-token");
  assert.equal(readFileSync(file, "utf8"), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
