import { createHash } from "node:crypto";
import type { EmbeddingModelV4, LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import type { EmbeddingModel, LanguageModel } from "ai";
import { z } from "zod";
import { FixtureNotFoundError } from "./errors";
import type { LlmFixture, MockRule } from "./types";

const DEFAULT_EMBED_DIMS = 768;

export function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Deterministic embedding from text hash — same text → same vector; semantic similarity not guaranteed. */
export function deterministicEmbedding(text: string, dimensions = DEFAULT_EMBED_DIMS): number[] {
  const vector = new Array<number>(dimensions);
  let seed = 0;
  const digest = createHash("sha256").update(text).digest();
  for (let i = 0; i < dimensions; i++) {
    const b = digest[i % digest.length]! ^ ((seed >> (i % 8)) & 0xff);
    seed = (seed * 31 + b + i) >>> 0;
    // Map to [-1, 1]
    vector[i] = (b / 255) * 2 - 1;
  }
  // L2 normalize
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vector.map((v) => v / norm);
}

function emptyUsage(promptChars: number) {
  return {
    inputTokens: { total: Math.max(1, Math.ceil(promptChars / 4)), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  };
}

/** Walk a Zod schema and produce a minimal valid value (for deterministic mock without fixtures). */
export function sampleFromSchema(schema: z.ZodType, depth = 0): unknown {
  if (depth > 12) return null;
  const def = (schema as unknown as { def?: { type?: string; [k: string]: unknown } }).def;
  if (!def?.type) return null;
  switch (def.type) {
    case "string":
      return "";
    case "number":
    case "int":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "literal":
      return (def as { values: unknown[] }).values[0];
    case "enum": {
      const entries = (def as { entries: Record<string, string> }).entries;
      return Object.values(entries)[0] ?? "";
    }
    case "optional":
    case "nullable":
      return sampleFromSchema((def as { innerType: z.ZodType }).innerType, depth + 1);
    case "array": {
      const element = (def as { element: z.ZodType }).element;
      return [sampleFromSchema(element, depth + 1)];
    }
    case "object": {
      const shape = (def as { shape: Record<string, z.ZodType> }).shape;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) out[key] = sampleFromSchema(value, depth + 1);
      return out;
    }
    case "union":
    case "discriminatedUnion": {
      const options = (def as { options: z.ZodType[] }).options;
      return sampleFromSchema(options[0]!, depth + 1);
    }
    case "default":
      return sampleFromSchema((def as { innerType: z.ZodType }).innerType, depth + 1);
    default:
      return null;
  }
}

export type ScriptedFailure = {
  providerId: string;
  /** Remaining throws before succeeding (HTTP-style). */
  remaining: number;
  statusCode?: number;
  message?: string;
};

export type MockProviderOptions = {
  /** Prefetched fixtures keyed by `${task}:${inputHash}`. */
  fixtures?: Iterable<LlmFixture>;
  /** Directory loader can populate fixtures; rules take precedence over schema sampling. */
  rules?: MockRule[];
  /** When true (default in replay-only mode), missing fixtures throw FixtureNotFoundError. */
  requireFixture?: boolean;
  embeddingDimensions?: number;
  modelId?: string;
};

export class MockProviderState {
  readonly fixtures = new Map<string, LlmFixture>();
  rules: MockRule[] = [];
  requireFixture: boolean;
  embeddingDimensions: number;
  modelId: string;
  /** Per-provider scripted HTTP failures for retry / fallback tests. */
  scriptedFailures = new Map<string, ScriptedFailure>();

  constructor(options: MockProviderOptions = {}) {
    this.requireFixture = options.requireFixture ?? false;
    this.embeddingDimensions = options.embeddingDimensions ?? DEFAULT_EMBED_DIMS;
    this.modelId = options.modelId ?? "deterministic";
    if (options.fixtures) {
      for (const fixture of options.fixtures) this.registerFixture(fixture);
    }
    if (options.rules) this.rules = [...options.rules];
  }

  /** Make `providerId` throw statusCode `times` times, then succeed. */
  scriptFailures(providerId: string, times: number, statusCode = 503, message = "unavailable"): void {
    this.scriptedFailures.set(providerId, { providerId, remaining: times, statusCode, message });
  }

  registerFixture(fixture: LlmFixture): void {
    this.fixtures.set(`${fixture.task}:${fixture.inputHash}`, fixture);
  }

  addRule(rule: MockRule): void {
    this.rules.push(rule);
  }

  consumeScriptedFailure(providerId: string): void {
    const scripted = this.scriptedFailures.get(providerId);
    if (!scripted || scripted.remaining <= 0) return;
    scripted.remaining -= 1;
    throw new APICallError({
      message: scripted.message ?? "unavailable",
      url: "mock://local",
      requestBodyValues: {},
      statusCode: scripted.statusCode ?? 503,
      isRetryable: true
    });
  }

  resolveOutput(args: { task?: string; prompt: string; system?: string; input?: unknown; schema?: z.ZodType; providerId?: string }): {
    output: unknown;
    usage: { inputTokens: number; outputTokens: number };
    fixture?: LlmFixture;
  } {
    if (args.providerId) this.consumeScriptedFailure(args.providerId);

    const input = args.input ?? tryParseJson(args.prompt) ?? args.prompt;
    const inputHash = hashInput(input);
    const task = args.task ?? "unknown";

    if (args.task) {
      const fixture = this.fixtures.get(`${task}:${inputHash}`);
      if (fixture) {
        return {
          output: fixture.output,
          usage: {
            inputTokens: fixture.usage?.inputTokens ?? Math.ceil(args.prompt.length / 4),
            outputTokens: fixture.usage?.outputTokens ?? 1
          },
          fixture
        };
      }
      if (this.requireFixture) throw new FixtureNotFoundError(task, inputHash);
    }

    for (const rule of this.rules) {
      const matched =
        typeof rule.match === "string"
          ? args.prompt.includes(rule.match) || JSON.stringify(input).includes(rule.match)
          : rule.match({ prompt: args.prompt, system: args.system, input });
      if (matched) {
        return {
          output: rule.output,
          usage: { inputTokens: Math.ceil(args.prompt.length / 4), outputTokens: 1 }
        };
      }
    }

    if (args.schema) {
      return {
        output: sampleFromSchema(args.schema),
        usage: { inputTokens: Math.ceil(args.prompt.length / 4), outputTokens: 1 }
      };
    }

    return { output: {}, usage: { inputTokens: Math.ceil(args.prompt.length / 4), outputTokens: 1 } };
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createMockLanguageModel(state: MockProviderState, task?: string, schema?: z.ZodType): LanguageModel {
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: state.modelId,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions) {
      const prompt = JSON.stringify(options.prompt);
      const resolved = state.resolveOutput({ task, prompt, schema, input: tryParseJson(prompt) });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(resolved.output) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: emptyUsage(prompt.length),
        warnings: []
      };
    },
    async doStream() {
      throw new Error("mock model does not stream");
    }
  };
  return model;
}

export function createMockEmbeddingModel(state: MockProviderState): EmbeddingModel {
  const model: EmbeddingModelV4 = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: `${state.modelId}-embed`,
    maxEmbeddingsPerCall: 64,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map((value) => deterministicEmbedding(value, state.embeddingDimensions)),
        usage: { tokens: values.reduce((sum, value) => sum + Math.ceil(value.length / 4), 0) },
        warnings: []
      };
    }
  };
  return model;
}

export function createMockProvider(options: MockProviderOptions = {}) {
  const state = new MockProviderState(options);
  return {
    state,
    languageModel(task?: string, schema?: z.ZodType): LanguageModel {
      return createMockLanguageModel(state, task, schema);
    },
    embeddingModel(): EmbeddingModel {
      return createMockEmbeddingModel(state);
    }
  };
}
