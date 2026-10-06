import type { OrganizeStage } from "@study-studio/shared";
import type { z } from "zod";
import type { GenerativeAiTask } from "../../ai/types.js";
import type { OrganizeGateway, UsageTracker } from "./runtime-types.js";
import type { TraceRecorder } from "./trace.js";

export type LlmContext = {
  gateway: OrganizeGateway;
  usage: UsageTracker;
  allowOverLimit: boolean;
  signal?: AbortSignal;
  trace?: TraceRecorder;
};

export type LlmCall<T> = {
  stage: OrganizeStage;
  task: GenerativeAiTask;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  promptVersion: string;
  /** Task input object: fixture replay hashes and matches on it. */
  input: unknown;
  /** `organize_traces.step`; defaults to `task`. */
  traceStep?: string;
};

export async function callLlm<T>(ctx: LlmContext, call: LlmCall<T>): Promise<{ object: T; model: string }> {
  const traceInput = { prompt_version: call.promptVersion, input: call.input };
  const step = call.traceStep ?? call.task;
  let result: Awaited<ReturnType<OrganizeGateway["generateObject"]>>;
  try {
    result = await ctx.gateway.generateObject({
      task: call.task,
      schema: call.schema,
      system: call.system,
      prompt: call.prompt,
      promptVersion: call.promptVersion,
      input: call.input,
      allowOverLimit: ctx.allowOverLimit,
      abortSignal: ctx.signal
    });
  } catch (error) {
    ctx.trace?.record(call.stage, step, traceInput, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  ctx.usage.record(call.stage, result.usage, result.model);
  ctx.trace?.record(call.stage, step, traceInput, result.object, {
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens
  });
  return { object: result.object as T, model: result.model };
}

/** Embedding that degrades to null (no vector recall) when the embedding task is unavailable. */
export async function tryEmbed(ctx: LlmContext, text: string): Promise<number[] | null> {
  const value = text.trim();
  if (!value) return null;
  try {
    const result = await ctx.gateway.embed({ value: value.slice(0, 8000), allowOverLimit: ctx.allowOverLimit, abortSignal: ctx.signal });
    ctx.usage.record("embedding", result.usage, result.model);
    return result.embedding;
  } catch (error) {
    if (isUsageLimitError(error)) throw error;
    return null;
  }
}

export function isUsageLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "UsageLimitExceededError";
}
