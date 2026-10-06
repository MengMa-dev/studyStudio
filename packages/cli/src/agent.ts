import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installAgent, SKILL_DIRS, type McpEndpoint } from "@study-studio/local-ingestion";

export type AgentTarget = keyof typeof SKILL_DIRS;
export const AGENT_TARGETS = Object.keys(SKILL_DIRS) as AgentTarget[];

export function readMcpEndpoint(dataDir: string, port: number): McpEndpoint {
  const file = join(dataDir, "mcp-token");
  const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!token) throw new Error(`未找到 ${file}：请先启动一次服务（study-studio 或 npm start），并确认 --data-dir 一致。`);
  return { url: `http://127.0.0.1:${port}/mcp`, token };
}

export function installAgents(targets: AgentTarget[], endpoint: McpEndpoint, home: string = homedir()): string[] {
  const lines = targets.flatMap((target) => {
    const result = installAgent(target, endpoint, home);
    return [`[${target}] skill → ${result.skillPath}`, result.ok ? `[${target}] MCP → ${result.mcpConfig}` : `[${target}] MCP 未完成：${result.manual}`];
  });
  return [...lines, "重新加载对应 agent（Cursor 需重启或在 MCP 设置中刷新）后生效，然后对 agent 说「整理收件箱」。"];
}
