import { generateObject, embed as aiEmbed, streamText } from "ai";
import {
  AllModelsFailedError,
  ContextTooLongError,
  FixtureNotFoundError,
  ProviderNotFoundError,
  TaskModelNotConfiguredError,
  ToolsNotSupportedError,
  UsageLimitExceededError
} from "./errors";
import { createMockProvider, type MockProviderOptions } from "./mock";
import { createProviderRuntime, type CreateProviderRuntimeOptions, type ProviderRuntime } from "./providers";
import { prepareSchemaForProvider, schemaHintForPrompt, unwrapUnionResult } from "./schema-wrap";
import {
  errorMessage,
  isContextTooLongError,
  isRetryableProviderError,
  isToolsUnsupportedError,
  quotaCooldownMs,
  withRetries,
  type RetryOptions
} from "./retry";
import { MemoryProviderConfigStore, utcDay } from "./stores";
import type {
  AiTask,
  EmbedParams,
  EmbedResult,
  GenerateObjectParams,
  GenerateObjectResult,
  ProviderConfig,
  ProviderConfigStore,
  ResolvedModel,
  StreamChatParams,
  StreamChatResult,
  UsageStore
} from "./types";

export type AiGatewayOptions = {
  configStore: ProviderConfigStore;
  usageStore: UsageStore;
  /** Shared mock options (fixtures / rules) when a mock provider is used. */
  mock?: MockProviderOptions;
  retry?: RetryOptions;
  /** Override "today" for tests (YYYY-MM-DD). */
  nowDay?: () => string;
  /** Default embedding dimensions when not specified by model. */
  embeddingDimensions?: number;
};

const PRE_OUTPUT_PART_TYPES = new Set<string>(["start", "start-step", "text-start", "reasoning-start", "raw"]);

type AttemptFailure = {
  role: "primary" | "fallback";
  providerId: string;
  model: string;
  error: string;
};

export class AiGateway {
  private readonly configStore: ProviderConfigStore;
  private readonly usageStore: UsageStore;
  private readonly mockOptions: MockProviderOptions;
  private readonly retry: RetryOptions;
  private readonly nowDay: () => string;
  private readonly embeddingDimensions: number;
  private readonly runtimeCache = new Map<string, ProviderRuntime>();
  /** provider/model → epoch ms until which the model is skipped (quota exhausted). */
  private readonly cooldowns = new Map<string, number>();
  /** Shared mock state so fixtures registered via gateway.apply to the provider. */
  private readonly mock = createMockProvider();

  constructor(options: AiGatewayOptions) {
    this.configStore = options.configStore;
    this.usageStore = options.usageStore;
    this.mockOptions = options.mock ?? {};
    this.retry = { retries: 3, baseDelayMs: 200, ...options.retry };
    this.nowDay = options.nowDay ?? utcDay;
    this.embeddingDimensions = options.embeddingDimensions ?? 768;
    if (options.mock?.fixtures) {
      for (const fixture of options.mock.fixtures) this.mock.state.registerFixture(fixture);
    }
    if (options.mock?.rules) {
      for (const rule of options.mock.rules) this.mock.state.addRule(rule);
    }
    if (options.mock?.requireFixture != null) this.mock.state.requireFixture = options.mock.requireFixture;
    if (options.mock?.embeddingDimensions) this.mock.state.embeddingDimensions = options.mock.embeddingDimensions;
    if (options.mock?.chatRules) this.mock.state.chatRules = [...options.mock.chatRules];
    if (options.mock?.chatToolsUnsupported) this.mock.state.chatToolsUnsupported = true;
  }

  /** Expose mock state for tests / fixture registration. */
  get mockState() {
    return this.mock.state;
  }

  registerFixture(...args: Parameters<typeof this.mock.state.registerFixture>): void {
    this.mock.state.registerFixture(...args);
  }

  private async resolveModels(task: AiTask): Promise<ResolvedModel[]> {
    const taskModel = (await this.configStore.getTaskModel(task)) ?? (task === "chat" ? await this.configStore.getTaskModel("knowledge_processing") : null);
    if (!taskModel) throw new TaskModelNotConfiguredError(task);
    const primary = await this.configStore.getProvider(taskModel.providerId);
    if (!primary) throw new ProviderNotFoundError(taskModel.providerId);
    const models: ResolvedModel[] = [{ task, provider: primary, modelId: taskModel.model, role: "primary" }];
    if (taskModel.fallbackProviderId && taskModel.fallbackModel) {
      const fallback = await this.configStore.getProvider(taskModel.fallbackProviderId);
      if (fallback) {
        models.push({
          task,
          provider: fallback,
          modelId: taskModel.fallbackModel,
          role: "fallback"
        });
      }
    }
    return this.withoutCooledDown(models);
  }

  /** Skips models whose quota is exhausted; if every model is cooling down, all are tried anyway. */
  private withoutCooledDown(models: ResolvedModel[]): ResolvedModel[] {
    const now = Date.now();
    const available = models.filter((model) => (this.cooldowns.get(`${model.provider.id}/${model.modelId}`) ?? 0) <= now);
    return available.length > 0 ? available : models;
  }

  private noteFailure(resolved: ResolvedModel, error: unknown): void {
    const cooldown = quotaCooldownMs(error);
    if (cooldown === null) return;
    this.cooldowns.set(`${resolved.provider.id}/${resolved.modelId}`, Date.now() + cooldown);
    console.warn(`[ai] ${resolved.provider.id}/${resolved.modelId} quota exhausted; skipped for ${Math.round(cooldown / 60_000)} min`);
  }

  private getRuntime(provider: ProviderConfig): ProviderRuntime {
    // Keyed by connection fields so settings edits take effect without a restart.
    const cacheKey = [provider.id, provider.type, provider.baseUrl ?? "", provider.apiKey ?? ""].join("\0");
    const cached = this.runtimeCache.get(cacheKey);
    if (cached) return cached;
    const createOptions: CreateProviderRuntimeOptions = { mock: this.mockOptions };
    let runtime: ProviderRuntime;
    if (provider.type === "mock") {
      runtime = {
        type: "mock",
        languageModel: () => ({
          model: this.mock.languageModel(undefined, undefined, provider.id),
          wrapTopLevelUnion: false,
          supportsStructuredOutputs: true
        }),
        embeddingModel: (_modelId, dimensions = this.mock.state.embeddingDimensions) => ({
          model: this.mock.embeddingModel(),
          dimensions
        }),
        listModels: async () => [this.mock.state.modelId, `${this.mock.state.modelId}-embed`]
      };
    } else {
      runtime = createProviderRuntime(provider, createOptions);
    }
    this.runtimeCache.set(cacheKey, runtime);
    return runtime;
  }

  private async assertWithinLimit(allowOverLimit: boolean | undefined): Promise<void> {
    const limit = await this.configStore.getDailyTokenLimit();
    if (limit == null) return;
    const day = this.nowDay();
    const used = await this.usageStore.getDayTotalTokens(day);
    if (used >= limit && !allowOverLimit) {
      throw new UsageLimitExceededError(day, used, limit);
    }
  }

  private async recordUsage(task: AiTask, providerId: string, inputTokens: number, outputTokens: number): Promise<void> {
    await this.usageStore.record({
      day: this.nowDay(),
      task,
      providerId,
      inputTokens,
      outputTokens
    });
  }

  /**
   * Structured object generation with union wrapping, JSON-mode fallback + one repair retry,
   * 429/5xx backoff, and fallback model switch.
   */
  async generateObject<T>(params: GenerateObjectParams<T>): Promise<GenerateObjectResult<T>> {
    await this.assertWithinLimit(params.allowOverLimit);
    const models = await this.resolveModels(params.task);
    const failures: AttemptFailure[] = [];

    for (const resolved of models) {
      try {
        const result = await this.generateWithModel(resolved, params);
        await this.recordUsage(params.task, resolved.provider.id, result.usage.inputTokens, result.usage.outputTokens);
        return {
          object: result.object,
          promptVersion: params.promptVersion,
          providerId: resolved.provider.id,
          model: resolved.modelId,
          usedFallback: resolved.role === "fallback",
          usage: result.usage
        };
      } catch (error) {
        if (error instanceof ContextTooLongError || error instanceof UsageLimitExceededError || error instanceof FixtureNotFoundError) {
          throw error;
        }
        this.noteFailure(resolved, error);
        failures.push({
          role: resolved.role,
          providerId: resolved.provider.id,
          model: resolved.modelId,
          error: errorMessage(error)
        });
        console.warn(`[ai] ${params.task} ${resolved.role} ${resolved.provider.id}/${resolved.modelId} failed: ${errorMessage(error).slice(0, 500)}`);
        if (isContextTooLongError(error)) throw new ContextTooLongError(errorMessage(error), { cause: error });
      }
    }

    throw new AllModelsFailedError(failures);
  }

  private async generateWithModel<T>(
    resolved: ResolvedModel,
    params: GenerateObjectParams<T>
  ): Promise<{ object: T; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    const runtime = this.getRuntime(resolved.provider);

    // Fixture-aware mock path: prefer gateway mock state with task + inputHash.
    if (resolved.provider.type === "mock") {
      return this.generateWithMock(resolved, params);
    }

    return withRetries(async () => {
      const structuredHandle = runtime.languageModel(resolved.modelId, { structuredOutputs: true });
      const prepared = prepareSchemaForProvider(params.schema, structuredHandle.wrapTopLevelUnion);
      const baseSystem = (params.system ?? "") + prepared.systemSuffix;

      try {
        const result = await generateObject({
          model: structuredHandle.model,
          schema: prepared.schema,
          system: baseSystem,
          prompt: params.prompt,
          maxRetries: 0,
          abortSignal: params.abortSignal
        });
        return {
          object: unwrapUnionResult<T>(result.object, prepared.wrapped),
          usage: normalizeUsage(result.usage)
        };
      } catch (structuredError) {
        if (isContextTooLongError(structuredError)) throw structuredError;
        if (isRetryableProviderError(structuredError)) throw structuredError;

        // Fallback: JSON mode + schema in prompt + local validation + one repair retry.
        const jsonHandle = runtime.languageModel(resolved.modelId, { structuredOutputs: false });
        const jsonPrepared = prepareSchemaForProvider(params.schema, jsonHandle.wrapTopLevelUnion);
        const hint = schemaHintForPrompt(jsonPrepared.schema);
        const result = await generateObject({
          model: jsonHandle.model,
          schema: jsonPrepared.schema,
          system: (params.system ?? "") + jsonPrepared.systemSuffix + hint,
          prompt: params.prompt,
          maxRetries: 0,
          abortSignal: params.abortSignal,
          repairText: async ({ text, error }) => {
            // One repair attempt: ask the same model to fix JSON against the schema.
            try {
              const repaired = await generateObject({
                model: jsonHandle.model,
                schema: jsonPrepared.schema,
                system: (params.system ?? "") + jsonPrepared.systemSuffix + hint + `\n上一次输出无效（${error.message}），请只输出修正后的 JSON。`,
                prompt: text,
                maxRetries: 0,
                abortSignal: params.abortSignal
              });
              return JSON.stringify(repaired.object);
            } catch {
              return text;
            }
          }
        });
        return {
          object: unwrapUnionResult<T>(result.object, jsonPrepared.wrapped),
          usage: normalizeUsage(result.usage)
        };
      }
    }, this.retry);
  }

  private async generateWithMock<T>(
    resolved: ResolvedModel,
    params: GenerateObjectParams<T>
  ): Promise<{ object: T; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    return withRetries(async () => {
      const input =
        params.input ??
        (() => {
          try {
            return JSON.parse(params.prompt);
          } catch {
            return params.prompt;
          }
        })();
      const resolvedOut = this.mock.state.resolveOutput({
        task: params.task,
        prompt: params.prompt,
        system: params.system,
        input,
        schema: params.schema,
        providerId: resolved.provider.id
      });
      const prepared = prepareSchemaForProvider(params.schema, false);
      const parsed = prepared.schema.parse(prepared.wrapped ? { result: resolvedOut.output } : resolvedOut.output);
      const object = unwrapUnionResult<T>(parsed, prepared.wrapped);
      return {
        object,
        usage: {
          inputTokens: resolvedOut.usage.inputTokens,
          outputTokens: resolvedOut.usage.outputTokens,
          totalTokens: resolvedOut.usage.inputTokens + resolvedOut.usage.outputTokens
        }
      };
    }, this.retry);
  }

  /** Checks done before a chat stream opens (mapped to HTTP status by the route); returns the primary model. */
  async prepareChat(allowOverLimit?: boolean): Promise<{ providerId: string; model: string }> {
    const [primary] = await this.resolveModels("chat");
    await this.assertWithinLimit(allowOverLimit);
    return { providerId: primary!.provider.id, model: primary!.modelId };
  }

  /**
   * Streaming chat. Switches to the fallback model only while no output chunk has been produced;
   * later failures surface as error parts in the stream. Usage is recorded when the stream ends.
   */
  async streamChat(params: StreamChatParams): Promise<StreamChatResult> {
    const models = await this.resolveModels("chat");
    await this.assertWithinLimit(params.allowOverLimit);
    const failures: AttemptFailure[] = [];

    for (const resolved of models) {
      try {
        const result = await withRetries(() => this.startChatStream(resolved, params), this.retry);
        return { result, providerId: resolved.provider.id, model: resolved.modelId, usedFallback: resolved.role === "fallback" };
      } catch (error) {
        if (params.abortSignal?.aborted) throw error;
        if (error instanceof ContextTooLongError) throw error;
        if (params.tools && isToolsUnsupportedError(error)) throw new ToolsNotSupportedError(resolved.provider.id, resolved.modelId, { cause: error });
        this.noteFailure(resolved, error);
        failures.push({ role: resolved.role, providerId: resolved.provider.id, model: resolved.modelId, error: errorMessage(error) });
        console.warn(`[ai] chat ${resolved.role} ${resolved.provider.id}/${resolved.modelId} failed: ${errorMessage(error).slice(0, 500)}`);
      }
    }
    throw new AllModelsFailedError(failures);
  }

  /** Resolves once the stream yields its first output chunk; rejects if it errors before that. */
  private async startChatStream(resolved: ResolvedModel, params: StreamChatParams): Promise<StreamChatResult["result"]> {
    const handle = this.getRuntime(resolved.provider).languageModel(resolved.modelId, { structuredOutputs: false });
    let started = false;
    const result = streamText({
      model: handle.model,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      stopWhen: params.stopWhen,
      maxRetries: 0,
      abortSignal: params.abortSignal,
      onError: ({ error }) => {
        if (started) console.warn(`[ai] chat stream ${resolved.provider.id}/${resolved.modelId} failed: ${errorMessage(error).slice(0, 500)}`);
      },
      onEnd: async (event) => {
        const usage = normalizeUsage(event.totalUsage);
        await this.recordUsage("chat", resolved.provider.id, usage.inputTokens, usage.outputTokens);
      }
    });
    // Reading a tee of the result does not consume the streams callers read later.
    const reader = result.fullStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "error") throw value.error;
        if (!PRE_OUTPUT_PART_TYPES.has(value.type)) break;
      }
      started = true;
      return result;
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  async embed(params: EmbedParams): Promise<EmbedResult> {
    await this.assertWithinLimit(params.allowOverLimit);
    const models = await this.resolveModels("embedding");
    const failures: AttemptFailure[] = [];

    for (const resolved of models) {
      try {
        const runtime = this.getRuntime(resolved.provider);
        const handle = runtime.embeddingModel(resolved.modelId, this.embeddingDimensions);
        const result = await withRetries(
          () =>
            aiEmbed({
              model: handle.model,
              value: params.value,
              maxRetries: 0,
              abortSignal: params.abortSignal
            }),
          this.retry
        );
        const usage = normalizeUsage(result.usage);
        await this.recordUsage("embedding", resolved.provider.id, usage.inputTokens, usage.outputTokens);
        return {
          embedding: result.embedding,
          providerId: resolved.provider.id,
          model: resolved.modelId,
          dimensions: handle.dimensions,
          usage
        };
      } catch (error) {
        if (error instanceof ContextTooLongError || error instanceof UsageLimitExceededError) throw error;
        this.noteFailure(resolved, error);
        failures.push({
          role: resolved.role,
          providerId: resolved.provider.id,
          model: resolved.modelId,
          error: errorMessage(error)
        });
        console.warn(`[ai] embedding ${resolved.role} ${resolved.provider.id}/${resolved.modelId} failed: ${errorMessage(error).slice(0, 500)}`);
      }
    }
    throw new AllModelsFailedError(failures);
  }
}

function normalizeUsage(usage: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; tokens?: number | null }): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = usage.inputTokens ?? usage.tokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/** Convenience: build a gateway wired to memory stores (tests / offline). */
export function createMemoryGateway(
  configStore: MemoryProviderConfigStore,
  usageStore: UsageStore,
  options: Omit<AiGatewayOptions, "configStore" | "usageStore"> = {}
): AiGateway {
  return new AiGateway({ configStore, usageStore, ...options });
}
