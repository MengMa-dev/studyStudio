import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel, type EmbeddingModel, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { AGENT_CLIENTS, createAgentLanguageModel } from "./agent-cli";
import { createMockProvider, type MockProviderOptions } from "./mock";
import type { EmbeddingModelHandle, LanguageModelHandle, ProviderConfig, ProviderType } from "./types";

export type ProviderRuntime = {
  type: ProviderType;
  languageModel: (modelId: string, options?: { structuredOutputs?: boolean }) => LanguageModelHandle;
  embeddingModel: (modelId: string, dimensions?: number) => EmbeddingModelHandle;
  /** Optional: list model ids for the settings dropdown. */
  listModels?: () => Promise<string[]>;
};

const DEFAULT_EMBED_DIMS = 768;
/** Ollama defaults to a 4096-token window and silently truncates longer prompts (judge inputs often exceed it). */
const OLLAMA_NUM_CTX = 16384;
/** Thinking models (qwen3) emit hundreds of reasoning tokens first, too slow on CPU-only machines. */
const OLLAMA_THINK = false;

export type CreateProviderRuntimeOptions = {
  mock?: MockProviderOptions;
};

/** Instantiate an SDK provider from config (openai-compatible / google / ollama / mock). */
export function createProviderRuntime(config: ProviderConfig, options: CreateProviderRuntimeOptions = {}): ProviderRuntime {
  switch (config.type) {
    case "mock": {
      const mock = createMockProvider(options.mock);
      return {
        type: "mock",
        languageModel: () => ({
          model: mock.languageModel(),
          wrapTopLevelUnion: false,
          supportsStructuredOutputs: true
        }),
        embeddingModel: (_modelId, dimensions = mock.state.embeddingDimensions) => ({
          model: mock.embeddingModel(),
          dimensions
        }),
        listModels: async () => [mock.state.modelId, `${mock.state.modelId}-embed`]
      };
    }
    case "ollama": {
      const baseURL = config.baseUrl ?? "http://127.0.0.1:11434/api";
      const ollama = createOllama({ baseURL });
      return {
        type: "ollama",
        languageModel: (modelId) => ({
          model: wrapLanguageModel({
            model: ollama(modelId),
            middleware: defaultSettingsMiddleware({ settings: { providerOptions: { ollama: { think: OLLAMA_THINK, options: { num_ctx: OLLAMA_NUM_CTX } } } } })
          }),
          wrapTopLevelUnion: false,
          supportsStructuredOutputs: true
        }),
        embeddingModel: (modelId, dimensions = DEFAULT_EMBED_DIMS) => ({
          model: ollama.embedding(modelId) as EmbeddingModel,
          dimensions
        }),
        listModels: () => listOpenAiCompatibleModels(stripApiSuffix(baseURL), undefined)
      };
    }
    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey ?? undefined,
        baseURL: config.baseUrl ?? undefined
      });
      return {
        type: "google",
        languageModel: (modelId) => ({
          model: google(modelId),
          wrapTopLevelUnion: false,
          supportsStructuredOutputs: true
        }),
        embeddingModel: (modelId, dimensions = DEFAULT_EMBED_DIMS) => ({
          model: google.embedding(modelId) as EmbeddingModel,
          dimensions
        }),
        listModels: async () => []
      };
    }
    case "agent-cli": {
      const client = AGENT_CLIENTS.find((candidate) => candidate === config.baseUrl);
      if (!client) throw new Error(`Unknown agent client: ${String(config.baseUrl)}`);
      return {
        type: "agent-cli",
        languageModel: (modelId) => ({ model: createAgentLanguageModel(client, modelId), wrapTopLevelUnion: false, supportsStructuredOutputs: false }),
        embeddingModel: () => {
          throw new Error("Agent 不提供 embedding，请为「向量 Embedding」选择其他服务商");
        },
        listModels: async () => ["default"]
      };
    }
    case "openai-compatible":
    case "anthropic": {
      // Anthropic via OpenAI-compatible gateways (DeepSeek/etc.) uses the same client path for this milestone.
      const baseURL = config.baseUrl ?? "https://api.openai.com/v1";
      return {
        type: config.type,
        languageModel: (modelId, opts) => {
          const structured = opts?.structuredOutputs ?? true;
          const provider = createOpenAICompatible({
            name: config.id,
            baseURL,
            apiKey: config.apiKey ?? undefined,
            supportsStructuredOutputs: structured
          });
          return {
            model: provider(modelId) as LanguageModel,
            wrapTopLevelUnion: true,
            supportsStructuredOutputs: structured
          };
        },
        embeddingModel: (modelId, dimensions = DEFAULT_EMBED_DIMS) => {
          const provider = createOpenAICompatible({
            name: config.id,
            baseURL,
            apiKey: config.apiKey ?? undefined
          });
          return {
            model: provider.textEmbeddingModel(modelId) as EmbeddingModel,
            dimensions
          };
        },
        listModels: () => listOpenAiCompatibleModels(baseURL, config.apiKey ?? undefined)
      };
    }
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unsupported provider type: ${String(exhaustive)}`);
    }
  }
}

function stripApiSuffix(baseURL: string): string {
  return baseURL.replace(/\/api\/?$/, "");
}

async function listOpenAiCompatibleModels(baseURL: string, apiKey?: string): Promise<string[]> {
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
    if (Array.isArray(body.data)) return body.data.map((row) => row.id).filter((id): id is string => Boolean(id));
    if (Array.isArray(body.models)) return body.models.map((row) => row.name).filter((id): id is string => Boolean(id));
    return [];
  } catch {
    return [];
  }
}
