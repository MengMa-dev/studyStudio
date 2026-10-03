import {
  AI_API,
  aiLimitsSchema,
  aiProviderCreateSchema,
  aiProviderDeleteResponseSchema,
  aiProviderPatchSchema,
  aiProviderSchema,
  aiProvidersResponseSchema,
  aiProviderTestRequestSchema,
  aiProviderTestResponseSchema,
  aiTasksResponseSchema,
  aiTasksUpdateSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
  type AiLimits,
  type AiProviderCreate,
  type AiProviderPatch,
  type AiProviderTestRequest,
  type AiTasksUpdateInput
} from "@study-studio/shared";

import { qs, request } from "./http";

export const realAiApi = {
  async listAiProviders() {
    return request(AI_API.providers, undefined, aiProvidersResponseSchema);
  },

  async createAiProvider(input: AiProviderCreate) {
    const body = aiProviderCreateSchema.parse(input);
    return request(AI_API.providers, { method: "POST", body: JSON.stringify(body) }, aiProviderSchema);
  },

  async patchAiProvider(id: string, patch: AiProviderPatch) {
    const body = aiProviderPatchSchema.parse(patch);
    return request(AI_API.provider(id), { method: "PATCH", body: JSON.stringify(body) }, aiProviderSchema);
  },

  async deleteAiProvider(id: string) {
    return request(AI_API.provider(id), { method: "DELETE" }, aiProviderDeleteResponseSchema);
  },

  async testAiProvider(id: string, overrides: AiProviderTestRequest = {}) {
    const body = aiProviderTestRequestSchema.parse(overrides);
    return request(AI_API.testProvider(id), { method: "POST", body: JSON.stringify(body) }, aiProviderTestResponseSchema);
  },

  async getAiTasks() {
    return request(AI_API.tasks, undefined, aiTasksResponseSchema);
  },

  async putAiTasks(update: AiTasksUpdateInput) {
    const body = aiTasksUpdateSchema.parse(update);
    return request(AI_API.tasks, { method: "PUT", body: JSON.stringify(body) }, aiTasksResponseSchema);
  },

  async getAiUsage(day?: string) {
    const query = aiUsageQuerySchema.parse({ day });
    return request(`${AI_API.usage}${qs({ day: query.day })}`, undefined, aiUsageResponseSchema);
  },

  async putAiLimits(limits: AiLimits) {
    const body = aiLimitsSchema.parse(limits);
    return request(AI_API.limits, { method: "PUT", body: JSON.stringify(body) }, aiLimitsSchema);
  }
};
