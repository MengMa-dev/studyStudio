import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { AGENT_SKILL_TARGETS, agentInstallRequestSchema, type AgentConfigResponse, type AgentSkillTarget } from "@study-studio/shared";
import { SecretsFile, secretsPathFor } from "../../ai/secrets.js";
import { SqliteAiConfigStore } from "../../ai/sqlite-stores.js";
import type { AppServices } from "../app.js";
import { requireWorkbenchSession } from "../auth.js";
import { installAgent, installStatus } from "../../domains/agent/install.js";
import { AGENT_SKILL_VERSION } from "../../domains/agent/tools.js";
import { parseJsonBody } from "./workbench.js";

const AGENT_LABELS: Record<AgentSkillTarget, string> = { cursor: "Cursor", claude: "Claude Code", codex: "Codex" };

/** AGENT_API: MCP address / token for external agents and per-client one-click skill + MCP install. */
export function registerAgentRoutes(api: Hono, services: AppServices): void {
  const { appDb, auth } = services;
  // The MCP token grants KB writes; the extension's pairing token must not read or reset it.
  api.use("/agent/*", requireWorkbenchSession(auth));

  const home = () => services.homeDir ?? homedir();
  const endpoint = () => ({ url: `http://127.0.0.1:${services.getPort()}/mcp`, token: auth.mcpToken });
  const aiConfig = services.aiConfig ?? new SqliteAiConfigStore(appDb.db, new SecretsFile(secretsPathFor(appDb.dataDir)));
  /** Installed agents show up as `agent-cli` providers so any generative task can pick them. */
  const ensureProvider = (target: AgentSkillTarget) => {
    if (aiConfig.getProvider(`agent-${target}`)) return;
    aiConfig.insertProvider({ id: `agent-${target}`, name: `${AGENT_LABELS[target]}（Agent）`, type: "agent-cli", baseUrl: target, defaultModel: "default" });
  };
  const config = (): AgentConfigResponse => {
    const installed = installStatus(home(), endpoint());
    for (const target of AGENT_SKILL_TARGETS) if (installed[target]) ensureProvider(target);
    return { ...endpoint(), skillVersion: AGENT_SKILL_VERSION, installed };
  };

  api.get("/agent/config", (c) => c.json(config()));

  api.post("/agent/token/reset", (c) => {
    const token = randomBytes(32).toString("base64url");
    if (appDb.dataDir) writeFileSync(join(appDb.dataDir, "mcp-token"), token, { mode: 0o600 });
    auth.mcpToken = token;
    return c.json(config());
  });

  api.post("/agent/install", async (c) => {
    const body = await parseJsonBody(c, agentInstallRequestSchema);
    if (!body.ok) return body.response;
    const result = installAgent(body.data.target, endpoint(), home());
    ensureProvider(body.data.target);
    return c.json(result);
  });
}
