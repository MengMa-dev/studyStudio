import { AGENT_API, agentConfigResponseSchema, agentInstallRequestSchema, agentInstallResultSchema, type AgentInstallRequest } from "@study-studio/shared";

import { request } from "./http";

export const realAgentApi = {
  async getAgentConfig() {
    return request(AGENT_API.config, undefined, agentConfigResponseSchema);
  },

  async resetAgentToken() {
    return request(AGENT_API.tokenReset, { method: "POST" }, agentConfigResponseSchema);
  },

  async installAgent(requestBody: AgentInstallRequest) {
    const body = agentInstallRequestSchema.parse(requestBody);
    return request(AGENT_API.install, { method: "POST", body: JSON.stringify(body) }, agentInstallResultSchema);
  }
};
