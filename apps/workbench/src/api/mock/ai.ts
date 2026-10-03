import {
  AI_TASK_NAMES,
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
  type AiProviderType,
  type AiTaskModel,
  type AiTasksUpdateInput
} from "@study-studio/shared";

type MockProvider = {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string | null;
  defaultModel: string | null;
  apiKey: string | null;
  status: "unconfigured" | "connected" | "error";
  checkedAt: string | null;
};

function createProviders(): MockProvider[] {
  return [
    {
      id: "ollama",
      name: "Ollama",
      type: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5:7b",
      apiKey: null,
      status: "connected",
      checkedAt: "2026-10-02T08:00:00.000Z"
    },
    {
      id: "gemini",
      name: "Gemini",
      type: "google",
      baseUrl: null,
      defaultModel: "gemini-3.8-flash",
      apiKey: "AIzaSyMockKey1234",
      status: "connected",
      checkedAt: "2026-10-02T08:00:00.000Z"
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      type: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: null,
      apiKey: null,
      status: "unconfigured",
      checkedAt: null
    }
  ];
}

function createTasks(): AiTaskModel[] {
  return [
    { task: "learning_judge", providerId: "ollama", model: "qwen2.5:7b", fallbackProviderId: null, fallbackModel: null },
    { task: "knowledge_processing", providerId: "gemini", model: "gemini-3.8-flash", fallbackProviderId: null, fallbackModel: null },
    { task: "entry_rewrite", providerId: "gemini", model: "gemini-3.5-flash-lite", fallbackProviderId: null, fallbackModel: null },
    { task: "embedding", providerId: "ollama", model: "nomic-embed-text", fallbackProviderId: null, fallbackModel: null }
  ];
}

let providers = createProviders();
let tasks = createTasks();
let dailyTokenLimit: number | null = 200_000;

export function resetMockAiState(): void {
  providers = createProviders();
  tasks = createTasks();
  dailyTokenLimit = 200_000;
}

function mask(key: string | null): string | null {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : null;
}

function toResponse(provider: MockProvider) {
  return aiProviderSchema.parse({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKeyMasked: mask(provider.apiKey),
    hasApiKey: provider.apiKey !== null,
    status: provider.status,
    checkedAt: provider.checkedAt,
    usedByTasks: tasks.filter((task) => task.providerId === provider.id || task.fallbackProviderId === provider.id).map((task) => task.task)
  });
}

function findProvider(id: string): MockProvider {
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Provider not found: ${id}`);
  return provider;
}

export const mockAiApi = {
  async listAiProviders() {
    return aiProvidersResponseSchema.parse({ providers: providers.map(toResponse) });
  },

  async createAiProvider(input: AiProviderCreate) {
    const body = aiProviderCreateSchema.parse(input);
    const provider: MockProvider = {
      id: `provider-${Date.now()}`,
      name: body.name,
      type: body.type,
      baseUrl: body.baseUrl ?? null,
      defaultModel: body.defaultModel ?? null,
      apiKey: body.apiKey ?? null,
      status: "unconfigured",
      checkedAt: null
    };
    providers.push(provider);
    return toResponse(provider);
  },

  async patchAiProvider(id: string, patch: AiProviderPatch) {
    const body = aiProviderPatchSchema.parse(patch);
    const provider = findProvider(id);
    Object.assign(provider, Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)));
    return toResponse(provider);
  },

  async deleteAiProvider(id: string) {
    if (tasks.some((task) => task.providerId === id || task.fallbackProviderId === id)) throw new Error("API 409: provider_in_use");
    providers = providers.filter((provider) => provider.id !== id);
    return aiProviderDeleteResponseSchema.parse({ ok: true });
  },

  async testAiProvider(id: string, overrides: AiProviderTestRequest = {}) {
    aiProviderTestRequestSchema.parse(overrides);
    const provider = findProvider(id);
    const ok = provider.type === "ollama" || provider.apiKey !== null || overrides.apiKey !== undefined;
    provider.status = ok ? "connected" : "error";
    provider.checkedAt = new Date().toISOString();
    return aiProviderTestResponseSchema.parse({
      ok,
      latencyMs: 120,
      ...(ok ? { models: provider.defaultModel ? [provider.defaultModel] : [] } : { error: "missing api key" }),
      status: provider.status,
      checkedAt: provider.checkedAt
    });
  },

  async getAiTasks() {
    return aiTasksResponseSchema.parse({
      tasks: AI_TASK_NAMES.map(
        (name) => tasks.find((task) => task.task === name) ?? { task: name, providerId: null, model: null, fallbackProviderId: null, fallbackModel: null }
      )
    });
  },

  async putAiTasks(update: AiTasksUpdateInput) {
    const body = aiTasksUpdateSchema.parse(update);
    for (const next of body.tasks) {
      tasks = [...tasks.filter((task) => task.task !== next.task), next];
    }
    return mockAiApi.getAiTasks();
  },

  async getAiUsage(day?: string) {
    const query = aiUsageQuerySchema.parse({ day });
    const inputTokens = 15_200;
    const outputTokens = 2_420;
    return aiUsageResponseSchema.parse({
      day: query.day ?? new Date().toISOString().slice(0, 10),
      calls: 7,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      dailyTokenLimit,
      limitReached: dailyTokenLimit !== null && inputTokens + outputTokens >= dailyTokenLimit,
      rows: [
        { task: "learning_judge", providerId: "ollama", calls: 3, inputTokens: 4_200, outputTokens: 600 },
        { task: "knowledge_processing", providerId: "gemini", calls: 4, inputTokens: 11_000, outputTokens: 1_820 }
      ]
    });
  },

  async putAiLimits(limits: AiLimits) {
    const body = aiLimitsSchema.parse(limits);
    dailyTokenLimit = body.dailyTokenLimit;
    return aiLimitsSchema.parse({ dailyTokenLimit });
  }
};
