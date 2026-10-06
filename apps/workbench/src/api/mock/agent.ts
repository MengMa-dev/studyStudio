import {
  agentConfigResponseSchema,
  agentInstallRequestSchema,
  agentInstallResultSchema,
  type AgentInstallRequest,
  type AgentSkillTarget
} from "@study-studio/shared";

const SKILL_DIRS = { cursor: ".cursor", claude: ".claude", codex: ".codex" } as const;

let token = "mcp-mock-token-0001";
let installed: Record<AgentSkillTarget, boolean> = { cursor: false, claude: false, codex: false };

export function resetMockAgentState(): void {
  token = "mcp-mock-token-0001";
  installed = { cursor: false, claude: false, codex: false };
}

function config() {
  return agentConfigResponseSchema.parse({ url: "http://127.0.0.1:43118/mcp", token, skillVersion: 3, installed });
}

export const mockAgentApi = {
  async getAgentConfig() {
    return config();
  },

  async resetAgentToken() {
    token = `mcp-mock-token-${Date.now()}`;
    installed = { cursor: false, claude: false, codex: false };
    return config();
  },

  async installAgent(request: AgentInstallRequest) {
    const { target } = agentInstallRequestSchema.parse(request);
    installed = { ...installed, [target]: true };
    return agentInstallResultSchema.parse({
      target,
      ok: true,
      skillPath: `~/${SKILL_DIRS[target]}/skills/organize-kb/SKILL.md`,
      mcpConfig: target === "cursor" ? "~/.cursor/mcp.json" : target === "codex" ? "~/.codex/config.toml" : "claude mcp add (user scope)",
      manual: null
    });
  }
};
