import type { EmbeddingModel, LanguageModel, ModelMessage, streamText, ToolSet } from "ai";
import type { z } from "zod";

/** Tasks that go through the AI gateway (06). `chat` falls back to the `knowledge_processing` model when unset. */
export const AI_TASKS = ["learning_judge", "knowledge_processing", "entry_rewrite", "embedding", "chat"] as const;
export type AiTask = (typeof AI_TASKS)[number];
export type GenerativeAiTask = Exclude<AiTask, "embedding">;

/** `agent-cli`: headless Cursor / Claude Code / Codex; `baseUrl` holds the client id. */
export const PROVIDER_TYPES = ["openai-compatible", "google", "ollama", "mock", "anthropic", "agent-cli"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export type ProviderConfig = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  defaultModel: string | null;
  /** From secrets.json; never persisted by DB stores. */
  apiKey?: string | null;
  status?: string | null;
};

export type TaskModelConfig = {
  task: AiTask;
  providerId: string;
  model: string;
  fallbackProviderId: string | null;
  fallbackModel: string | null;
};

export type UsageDayTotal = {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

export type UsageIncrement = {
  day: string;
  task: AiTask;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
};

/** Injected config/secrets source for gateway (DB impl lands in a later milestone). */
export interface ProviderConfigStore {
  getProvider(id: string): ProviderConfig | null | Promise<ProviderConfig | null>;
  listProviders(): ProviderConfig[] | Promise<ProviderConfig[]>;
  getTaskModel(task: AiTask): TaskModelConfig | null | Promise<TaskModelConfig | null>;
  /** Null / undefined = unlimited. */
  getDailyTokenLimit(): number | null | Promise<number | null>;
}

export interface UsageStore {
  getDayTotalTokens(day: string): number | Promise<number>;
  record(increment: UsageIncrement): void | Promise<void>;
}

export type ResolvedModel = {
  task: AiTask;
  provider: ProviderConfig;
  modelId: string;
  role: "primary" | "fallback";
};

export type LanguageModelHandle = {
  model: LanguageModel;
  /** openai-compatible providers need top-level union wrapping. */
  wrapTopLevelUnion: boolean;
  /** When false, skip structured JSON Schema and use JSON-mode fallback path first. */
  supportsStructuredOutputs: boolean;
};

export type EmbeddingModelHandle = {
  model: EmbeddingModel;
  dimensions: number;
};

export type GenerateObjectParams<T> = {
  task: GenerativeAiTask;
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  /** Written to organize_results.prompt_version by callers. */
  promptVersion: string;
  /** Manual run may continue past the daily cap after user confirmation. */
  allowOverLimit?: boolean;
  abortSignal?: AbortSignal;
  /** Optional input object used for fixture replay hashing (defaults to prompt). */
  input?: unknown;
};

export type GenerateObjectResult<T> = {
  object: T;
  promptVersion: string;
  providerId: string;
  model: string;
  usedFallback: boolean;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export type StreamChatParams = {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  stopWhen?: Parameters<typeof streamText<ToolSet>>[0]["stopWhen"];
  /** Chat may continue past the daily cap after the user confirms. */
  allowOverLimit?: boolean;
  abortSignal?: AbortSignal;
};

export type StreamChatResult = {
  result: ReturnType<typeof streamText<ToolSet>>;
  providerId: string;
  model: string;
  usedFallback: boolean;
};

export type EmbedParams = {
  value: string;
  allowOverLimit?: boolean;
  abortSignal?: AbortSignal;
};

export type EmbedResult = {
  embedding: number[];
  providerId: string;
  model: string;
  dimensions: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export type TestConnectionResult = {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: string;
};

/** Recorded LLM fixture (written under test/fixtures/llm/<task>/<name>.json). */
export type LlmFixture = {
  task: string;
  promptVersion: string;
  inputHash: string;
  provider: string;
  model: string;
  input: unknown;
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  recordedAt: string;
};

export type MockRule = {
  /** Match when prompt/input contains this substring, or a custom predicate. */
  match: string | ((input: { prompt: string; system?: string; input?: unknown }) => boolean);
  output: unknown;
};
