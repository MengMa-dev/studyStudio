import { generateText } from "ai";
import { createProviderRuntime } from "./providers";
import type { ProviderConfig, TestConnectionResult } from "./types";

/**
 * Send a minimal request and, when supported, list models for the settings dropdown.
 */
export async function testProviderConnection(config: ProviderConfig, options: { model?: string; timeoutMs?: number } = {}): Promise<TestConnectionResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    const runtime = createProviderRuntime(config);
    const modelId = options.model ?? config.defaultModel ?? "dummy";
    const handle = runtime.languageModel(modelId, { structuredOutputs: false });

    if (config.type === "mock") {
      const models = (await runtime.listModels?.()) ?? [];
      return { ok: true, latencyMs: Date.now() - started, models };
    }

    await generateText({
      model: handle.model,
      prompt: "ping",
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs)
    });

    const models = (await runtime.listModels?.()) ?? [];
    return { ok: true, latencyMs: Date.now() - started, models: models.length ? models : undefined };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
