import { createHash } from "node:crypto";
import type { EmbeddingModelV4, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
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

/**
 * Chat replay rule matched against the last user message. With `toolName` (and the tool offered),
 * the first step emits that tool call; the next step answers with `text`, or cites the first
 * `ref` found in the tool results / system prompt.
 */
export type MockChatRule = {
  match: string | RegExp;
  toolName?: string;
  input?: Record<string, unknown> | ((userText: string) => Record<string, unknown>);
  text?: string;
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
  chatRules?: MockChatRule[];
  chatToolsUnsupported?: boolean;
};

export class MockProviderState {
  readonly fixtures = new Map<string, LlmFixture>();
  rules: MockRule[] = [];
  requireFixture: boolean;
  embeddingDimensions: number;
  modelId: string;
  /** Per-provider scripted HTTP failures for retry / fallback tests. */
  scriptedFailures = new Map<string, ScriptedFailure>();
  /** Checked before the built-in chat rules. */
  chatRules: MockChatRule[] = [];
  /** Simulate a model that rejects requests carrying tools (400). */
  chatToolsUnsupported = false;
  /** Per-provider count of streams that fail right after the first text chunk. */
  midStreamFailures = new Map<string, number>();
  private toolCallSeq = 0;

  constructor(options: MockProviderOptions = {}) {
    this.requireFixture = options.requireFixture ?? false;
    this.embeddingDimensions = options.embeddingDimensions ?? DEFAULT_EMBED_DIMS;
    this.modelId = options.modelId ?? "deterministic";
    if (options.fixtures) {
      for (const fixture of options.fixtures) this.registerFixture(fixture);
    }
    if (options.rules) this.rules = [...options.rules];
    if (options.chatRules) this.chatRules = [...options.chatRules];
    this.chatToolsUnsupported = options.chatToolsUnsupported ?? false;
  }

  /** Make `providerId` throw statusCode `times` times, then succeed. */
  scriptFailures(providerId: string, times: number, statusCode = 503, message = "unavailable"): void {
    this.scriptedFailures.set(providerId, { providerId, remaining: times, statusCode, message });
  }

  scriptMidStreamFailure(providerId: string, times = 1): void {
    this.midStreamFailures.set(providerId, times);
  }

  consumeMidStreamFailure(providerId: string): boolean {
    const remaining = this.midStreamFailures.get(providerId) ?? 0;
    if (remaining <= 0) return false;
    this.midStreamFailures.set(providerId, remaining - 1);
    return true;
  }

  nextToolCallId(): string {
    this.toolCallSeq += 1;
    return `mock_call_${this.toolCallSeq}`;
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

function localDayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function stripTail(text: string): string {
  return text.replace(/[。.!！,，\s]+$/u, "").trim();
}

const DEFAULT_CHAT_RULES: MockChatRule[] = [
  {
    match: /整理/,
    toolName: "propose_organize",
    input: (text) => ({ target: /该页|当前|这篇|这个/.test(text) ? "current" : "ask" }),
    text: "请在下方卡片中确认整理范围。"
  },
  {
    match: /我是|我最近在学/,
    toolName: "record_learner_profile",
    input: (text) => {
      const direction = /我最近在学(.+)/.exec(text)?.[1];
      const role = /我是(.+)/.exec(text)?.[1];
      return direction ? { direction: stripTail(direction) } : { role: stripTail(role ?? text) };
    },
    text: "好的，已记录。"
  },
  {
    match: /今天|昨天|本周|这周|最近/,
    toolName: "query_timeline",
    input: () => {
      const today = localDayOf(new Date());
      return { from: today, to: today };
    }
  },
  { match: /掌握|薄弱/, toolName: "list_mastery", input: { level: "weak" } },
  { match: /[\s\S]*/, toolName: "search_knowledge", input: (text) => ({ query: text, k: 5 }) }
];

type ChatTurn = { kind: "tool"; toolName: string; input: Record<string, unknown> } | { kind: "text"; text: string };

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]!;
    if (message.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

function matchesRule(rule: MockChatRule, text: string): boolean {
  return typeof rule.match === "string" ? text.includes(rule.match) : rule.match.test(text);
}

function citedAnswer(evidence: string): string {
  const refs = [...new Set([...evidence.matchAll(/"ref":(\d+)/g)].map((match) => match[1]!))].slice(0, 2);
  if (refs.length === 0) return "知识库没有相关内容。以下内容非学习记录：这是 mock 模型基于通用知识的回答。";
  return `根据你的学习记录，相关内容见 ${refs.map((n) => `[${n}]`).join("")}。`;
}

function planChatTurn(state: MockProviderState, options: LanguageModelV4CallOptions): ChatTurn {
  const prompt = options.prompt;
  const userText = lastUserText(prompt);
  const rule = [...state.chatRules, ...DEFAULT_CHAT_RULES].find((candidate) => matchesRule(candidate, userText));
  const last = prompt.at(-1);
  const offered = new Set((options.tools ?? []).map((tool) => tool.name));
  if (last?.role !== "tool" && rule?.toolName && offered.has(rule.toolName)) {
    const input = typeof rule.input === "function" ? rule.input(userText) : (rule.input ?? {});
    return { kind: "tool", toolName: rule.toolName, input };
  }
  if (rule?.text) return { kind: "text", text: rule.text };
  const evidence =
    last?.role === "tool" ? JSON.stringify(last.content) : prompt.map((message) => (message.role === "system" ? message.content : "")).join("\n");
  return { kind: "text", text: citedAnswer(evidence) };
}

function streamParts(turn: ChatTurn, toolCallId: string, promptChars: number): LanguageModelV4StreamPart[] {
  const usage = {
    inputTokens: { total: Math.max(1, Math.ceil(promptChars / 4)), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: turn.kind === "text" ? Math.max(1, Math.ceil(turn.text.length / 4)) : 1, text: undefined, reasoning: undefined }
  };
  if (turn.kind === "tool") {
    return [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId, toolName: turn.toolName, input: JSON.stringify(turn.input) },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } }
    ];
  }
  const half = Math.ceil(turn.text.length / 2);
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: turn.text.slice(0, half) },
    { type: "text-delta", id: "t0", delta: turn.text.slice(half) },
    { type: "text-end", id: "t0" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } }
  ];
}

export function createMockLanguageModel(state: MockProviderState, task?: string, schema?: z.ZodType, providerId?: string): LanguageModel {
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
    async doStream(options: LanguageModelV4CallOptions) {
      if (providerId) state.consumeScriptedFailure(providerId);
      if (state.chatToolsUnsupported && options.tools?.length) {
        throw new APICallError({
          message: "Bad Request: this model does not support tools",
          url: "mock://local",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: '{"error":"tools not supported"}',
          isRetryable: false
        });
      }
      const parts = streamParts(planChatTurn(state, options), state.nextToolCallId(), JSON.stringify(options.prompt).length);
      const failMidStream = providerId ? state.consumeMidStreamFailure(providerId) : false;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
              if (failMidStream && part.type === "text-delta") {
                controller.enqueue({
                  type: "error",
                  error: new APICallError({ message: "stream interrupted", url: "mock://local", requestBodyValues: {}, statusCode: 503, isRetryable: true })
                });
                break;
              }
            }
            controller.close();
          }
        })
      };
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
    languageModel(task?: string, schema?: z.ZodType, providerId?: string): LanguageModel {
      return createMockLanguageModel(state, task, schema, providerId);
    },
    embeddingModel(): EmbeddingModel {
      return createMockEmbeddingModel(state);
    }
  };
}
