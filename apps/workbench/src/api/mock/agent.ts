import {
  agentConfigResponseSchema,
  agentSkillInstallRequestSchema,
  agentSkillInstallResponseSchema,
  type AgentSkillInstallRequest
} from "@study-studio/shared";

const SKILL_DIRS = { cursor: ".cursor", claude: ".claude", codex: ".codex" } as const;

let token = "mcp-mock-token-0001";

export function resetMockAgentState(): void {
  token = "mcp-mock-token-0001";
}

function config() {
  return agentConfigResponseSchema.parse({ url: "http://127.0.0.1:43118/mcp", token, skillVersion: 1 });
}

export const mockAgentApi = {
  async getAgentConfig() {
    return config();
  },

  async resetAgentToken() {
    token = `mcp-mock-token-${Date.now()}`;
    return config();
  },

  async installAgentSkill(request: AgentSkillInstallRequest) {
    const body = agentSkillInstallRequestSchema.parse(request);
    return agentSkillInstallResponseSchema.parse({
      paths: body.targets.map((target) => `~/${SKILL_DIRS[target]}/skills/organize-kb/SKILL.md`)
    });
  }
};
