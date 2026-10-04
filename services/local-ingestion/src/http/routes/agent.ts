import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { agentSkillInstallRequestSchema, type AgentConfigResponse, type AgentSkillTarget } from "@study-studio/shared";
import type { AppServices } from "../app.js";
import { requireWorkbenchSession } from "../auth.js";
import { SKILL_MARKDOWN, SKILL_NAME } from "../../domains/agent/skill.js";
import { AGENT_SKILL_VERSION } from "../../domains/agent/tools.js";
import { parseJsonBody } from "./workbench.js";

const SKILL_DIRS: Record<AgentSkillTarget, string> = { cursor: ".cursor", claude: ".claude", codex: ".codex" };

/** AGENT_API: MCP address / token for external agents and `organize-kb` skill install. */
export function registerAgentRoutes(api: Hono, services: AppServices): void {
  const { appDb, auth } = services;
  // The MCP token grants KB writes; the extension's pairing token must not read or reset it.
  api.use("/agent/*", requireWorkbenchSession(auth));

  const config = (): AgentConfigResponse => ({
    url: `http://127.0.0.1:${services.getPort()}/mcp`,
    token: auth.mcpToken,
    skillVersion: AGENT_SKILL_VERSION
  });

  api.get("/agent/config", (c) => c.json(config()));

  api.post("/agent/token/reset", (c) => {
    const token = randomBytes(32).toString("base64url");
    if (appDb.dataDir) writeFileSync(join(appDb.dataDir, "mcp-token"), token, { mode: 0o600 });
    auth.mcpToken = token;
    return c.json(config());
  });

  api.post("/agent/skill/install", async (c) => {
    const body = await parseJsonBody(c, agentSkillInstallRequestSchema);
    if (!body.ok) return body.response;
    const home = services.homeDir ?? homedir();
    const paths = [...new Set(body.data.targets)].map((target) => {
      const dir = join(home, SKILL_DIRS[target], "skills", SKILL_NAME);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "SKILL.md");
      writeFileSync(path, SKILL_MARKDOWN);
      return path;
    });
    return c.json({ paths });
  });
}
