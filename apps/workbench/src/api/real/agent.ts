import {
  AGENT_API,
  agentConfigResponseSchema,
  agentSkillInstallRequestSchema,
  agentSkillInstallResponseSchema,
  type AgentSkillInstallRequest
} from "@study-studio/shared";

import { request } from "./http";

export const realAgentApi = {
  async getAgentConfig() {
    return request(AGENT_API.config, undefined, agentConfigResponseSchema);
  },

  async resetAgentToken() {
    return request(AGENT_API.tokenReset, { method: "POST" }, agentConfigResponseSchema);
  },

  async installAgentSkill(requestBody: AgentSkillInstallRequest) {
    const body = agentSkillInstallRequestSchema.parse(requestBody);
    return request(AGENT_API.skillInstall, { method: "POST", body: JSON.stringify(body) }, agentSkillInstallResponseSchema);
  }
};
