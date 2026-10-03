import assert from "node:assert/strict";
import { test } from "node:test";
import { stepCountIs, tool } from "ai";
import { z } from "zod";
import { AllModelsFailedError, TaskModelNotConfiguredError, ToolsNotSupportedError, UsageLimitExceededError } from "../../src/ai/errors";
import { AiGateway } from "../../src/ai/gateway";
import { MemoryProviderConfigStore, MemoryUsageStore } from "../../src/ai/stores";

function setupGateway(options: { chatTask?: boolean; processingTask?: boolean; fallback?: boolean; limit?: number } = {}) {
  const config = new MemoryProviderConfigStore();
  const usage = new MemoryUsageStore();
  config.upsertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: "deterministic" });
  config.upsertProvider({ id: "mock-fallback", name: "Mock Fallback", type: "mock", baseUrl: null, defaultModel: "deterministic" });
  const fallback =
    options.fallback === false ? { fallbackProviderId: null, fallbackModel: null } : { fallbackProviderId: "mock-fallback", fallbackModel: "deterministic" };
  if (options.chatTask !== false) config.setTaskModel({ task: "chat", providerId: "mock", model: "deterministic", ...fallback });
  if (options.processingTask) config.setTaskModel({ task: "knowledge_processing", providerId: "mock-fallback", model: "kp-model", ...fallback });
  if (options.limit !== undefined) config.setDailyTokenLimit(options.limit);
  const gateway = new AiGateway({
    configStore: config,
    usageStore: usage,
    retry: { retries: 1, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-03"
  });
  return { gateway, config, usage };
}

const userMessage = (text: string) => [{ role: "user" as const, content: text }];

const searchTool = tool({
  description: "search",
  inputSchema: z.object({ query: z.string(), k: z.number().optional() }),
  execute: async () => ({ results: [{ ref: 1, title: "RAG" }] })
});

async function waitForUsage(usage: MemoryUsageStore, day: string) {
  for (let i = 0; i < 50 && (await usage.getDayTotalTokens(day)) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("streamChat streams text, runs tools across steps and records chat usage", async () => {
  const { gateway, usage } = setupGateway();
  const { result, providerId, usedFallback } = await gateway.streamChat({
    system: "sys",
    messages: userMessage("RAG 是什么"),
    tools: { search_knowledge: searchTool },
    stopWhen: stepCountIs(5)
  });
  assert.equal(providerId, "mock");
  assert.equal(usedFallback, false);
  const text = await result.text;
  assert.match(text, /\[1\]/);
  const steps = await result.steps;
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.toolCalls[0]!.toolName, "search_knowledge");
  await waitForUsage(usage, "2026-10-03");
  assert.ok((await usage.getDayTotalTokens("2026-10-03")) > 0);
});

test("streamChat switches to the fallback model only before the first chunk", async () => {
  const { gateway } = setupGateway();
  gateway.mockState.scriptFailures("mock", 2, 503);
  const switched = await gateway.streamChat({ system: "sys", messages: userMessage("你好") });
  assert.equal(switched.providerId, "mock-fallback");
  assert.equal(switched.usedFallback, true);
  assert.ok((await switched.result.text).length > 0);

  gateway.mockState.scriptMidStreamFailure("mock");
  const midStream = await gateway.streamChat({ system: "sys", messages: userMessage("你好") });
  assert.equal(midStream.providerId, "mock", "no switch once output started");
  const parts: string[] = [];
  for await (const part of midStream.result.fullStream) parts.push(part.type);
  assert.ok(parts.includes("text-delta"));
  assert.ok(parts.includes("error"));
});

test("streamChat throws AllModelsFailedError when every model fails before output", async () => {
  const { gateway } = setupGateway();
  gateway.mockState.scriptFailures("mock", 5, 503);
  gateway.mockState.scriptFailures("mock-fallback", 5, 503);
  await assert.rejects(gateway.streamChat({ system: "sys", messages: userMessage("你好") }), AllModelsFailedError);
});

test("streamChat falls back to the knowledge_processing model and requires one of them", async () => {
  const { gateway } = setupGateway({ chatTask: false, processingTask: true, fallback: false });
  const { providerId, model } = await gateway.streamChat({ system: "sys", messages: userMessage("你好") });
  assert.deepEqual({ providerId, model }, { providerId: "mock-fallback", model: "kp-model" });

  const empty = setupGateway({ chatTask: false });
  await assert.rejects(empty.gateway.streamChat({ system: "sys", messages: userMessage("你好") }), TaskModelNotConfiguredError);
  await assert.rejects(empty.gateway.prepareChat(), TaskModelNotConfiguredError);
});

test("streamChat enforces the daily limit unless allowOverLimit", async () => {
  const { gateway, usage } = setupGateway({ limit: 10 });
  await usage.record({ day: "2026-10-03", task: "chat", providerId: "mock", inputTokens: 10, outputTokens: 0 });
  await assert.rejects(gateway.streamChat({ system: "sys", messages: userMessage("你好") }), UsageLimitExceededError);
  await assert.rejects(gateway.prepareChat(false), UsageLimitExceededError);
  const allowed = await gateway.streamChat({ system: "sys", messages: userMessage("你好"), allowOverLimit: true });
  assert.ok((await allowed.result.text).length > 0);
});

test("streamChat reports models that reject tools", async () => {
  const { gateway } = setupGateway();
  gateway.mockState.chatToolsUnsupported = true;
  await assert.rejects(
    gateway.streamChat({ system: "sys", messages: userMessage("RAG"), tools: { search_knowledge: searchTool } }),
    (error: unknown) => error instanceof ToolsNotSupportedError && error.providerId === "mock"
  );
  const plain = await gateway.streamChat({ system: "sys", messages: userMessage("RAG") });
  assert.ok((await plain.result.text).length > 0);
});
