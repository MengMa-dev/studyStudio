import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentInstallResult, AgentSkillTarget } from "@study-studio/shared";
import { agentEnv } from "../../ai/agent-cli.js";
import { SKILL_DIRS, SKILL_MARKDOWN, SKILL_NAME } from "./skill.js";

const SERVER_NAME = "study-studio";

export type McpEndpoint = { url: string; token: string };

/** Merges into Cursor's `mcp.json`; an unparsable non-empty file throws instead of being overwritten. */
export function mergeCursorMcp(existing: string, endpoint: McpEndpoint): string {
  const config = existing.trim() ? (JSON.parse(existing) as { mcpServers?: Record<string, unknown> }) : {};
  config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Replaces (or appends) the `[mcp_servers.study-studio]` table in Codex's `config.toml`. */
export function mergeCodexMcp(existing: string, endpoint: McpEndpoint): string {
  const kept = existing.replace(new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "m"), "").trimEnd();
  const table = `[mcp_servers.${SERVER_NAME}]\nurl = "${endpoint.url}"\nhttp_headers = { Authorization = "Bearer ${endpoint.token}" }\n`;
  return kept ? `${kept}\n\n${table}` : table;
}

export function claudeAddArgs(endpoint: McpEndpoint): string[] {
  return ["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, endpoint.url, "--header", `Authorization: Bearer ${endpoint.token}`];
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

function mcpConfigPath(target: AgentSkillTarget, home: string): string {
  return target === "cursor" ? join(home, ".cursor", "mcp.json") : target === "codex" ? join(home, ".codex", "config.toml") : join(home, ".claude.json");
}

/** Installed = skill present and the client's MCP config carries the current token (a reset token reads as not installed). */
export function installStatus(home: string, endpoint: McpEndpoint): Record<AgentSkillTarget, boolean> {
  const status = {} as Record<AgentSkillTarget, boolean>;
  for (const target of Object.keys(SKILL_DIRS) as AgentSkillTarget[]) {
    status[target] =
      existsSync(join(home, SKILL_DIRS[target], "skills", SKILL_NAME, "SKILL.md")) && readText(mcpConfigPath(target, home)).includes(endpoint.token);
  }
  return status;
}

/** Writes the `organize-kb` skill and registers the MCP server for one client. */
export function installAgent(target: AgentSkillTarget, endpoint: McpEndpoint, home: string): AgentInstallResult {
  const skillPath = join(home, SKILL_DIRS[target], "skills", SKILL_NAME, "SKILL.md");
  writeFile(skillPath, SKILL_MARKDOWN);
  if (target === "claude") {
    const args = claudeAddArgs(endpoint);
    spawnSync("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME], { stdio: "ignore", env: agentEnv() });
    if (spawnSync("claude", args, { stdio: "ignore", env: agentEnv() }).status !== 0) {
      const manual = `claude ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`;
      return { target, ok: false, skillPath, mcpConfig: null, manual };
    }
    return { target, ok: true, skillPath, mcpConfig: "claude mcp add (user scope)", manual: null };
  }
  const path = mcpConfigPath(target, home);
  try {
    writeFile(path, (target === "cursor" ? mergeCursorMcp : mergeCodexMcp)(readText(path), endpoint));
  } catch {
    return { target, ok: false, skillPath, mcpConfig: null, manual: `${path} 不是合法的 JSON，请修正后重试` };
  }
  return { target, ok: true, skillPath, mcpConfig: path, manual: null };
}
