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

const MOCK_MODELS: Record<AiProviderType, string[]> = {
  ollama: ["qwen2.5:7b", "nomic-embed-text:latest", "bge-m3:latest"],
  google: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-embedding-2"],
  "openai-compatible": ["nvidia/nemotron-3-super-120b-a12b:free", "qwen/qwen3.8-27b:free", "openai/gpt-oss-120b"],
  anthropic: ["claude-sonnet-4.5"],
  mock: ["deterministic", "deterministic-embed"]
};

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
    const connectionChanged =
      (body.type !== undefined && body.type !== provider.type) ||
      (body.baseUrl !== undefined && body.baseUrl !== provider.baseUrl) ||
      (body.apiKey !== undefined && body.apiKey !== provider.apiKey);
    Object.assign(provider, Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)));
    if (connectionChanged) {
      provider.status = "unconfigured";
      provider.checkedAt = null;
    }
    return toResponse(provider);
  },

  async deleteAiProvider(id: string) {
    findProvider(id);
    const using = tasks.filter((task) => task.providerId === id || task.fallbackProviderId === id).map((task) => task.task);
    if (using.length) throw new Error(`API 409: ${JSON.stringify({ error: "provider_in_use", tasks: using })}`);
    providers = providers.filter((provider) => provider.id !== id);
    return aiProviderDeleteResponseSchema.parse({ ok: true });
  },

  async testAiProvider(id: string, overrides: AiProviderTestRequest = {}) {
    const body = aiProviderTestRequestSchema.parse(overrides);
    const provider = findProvider(id);
    const ok = provider.type === "ollama" || provider.type === "mock" || provider.apiKey !== null || body.apiKey !== undefined;
    const status = ok ? "connected" : "error";
    const checkedAt = new Date().toISOString();
    if (body.apiKey === undefined && body.baseUrl === undefined) {
      provider.status = status;
      provider.checkedAt = checkedAt;
    }
    return aiProviderTestResponseSchema.parse({
      ok,
      latencyMs: 120,
      ...(ok ? { models: MOCK_MODELS[provider.type] } : { error: "missing api key" }),
      status,
      checkedAt
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
      for (const providerId of [next.providerId, next.fallbackProviderId]) {
        if (providerId) findProvider(providerId);
      }
    }
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
