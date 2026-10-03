import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AllModelsFailedError, FixtureNotFoundError, UsageLimitExceededError } from "../../src/ai/errors";
import { AiGateway } from "../../src/ai/gateway";
import { deterministicEmbedding, hashInput, sampleFromSchema } from "../../src/ai/mock";
import { MemoryProviderConfigStore, MemoryUsageStore } from "../../src/ai/stores";
import type { LlmFixture } from "../../src/ai/types";

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("new"),
    item_id: z.string(),
    name: z.string(),
    value_score: z.number()
  }),
  z.object({
    decision: z.literal("reject"),
    item_id: z.string(),
    reason: z.string(),
    value_score: z.number()
  })
]);

function setupGateway(overrides?: { limit?: number | null; requireFixture?: boolean; fixtures?: LlmFixture[] }) {
  const config = new MemoryProviderConfigStore();
  const usage = new MemoryUsageStore();
  config.upsertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: "deterministic" });
  config.upsertProvider({ id: "mock-fallback", name: "Mock Fallback", type: "mock", baseUrl: null, defaultModel: "deterministic" });
  config.setTaskModel({
    task: "knowledge_processing",
    providerId: "mock",
    model: "deterministic",
    fallbackProviderId: "mock-fallback",
    fallbackModel: "deterministic"
  });
  config.setTaskModel({
    task: "embedding",
    providerId: "mock",
    model: "deterministic-embed",
    fallbackProviderId: null,
    fallbackModel: null
  });
  if (overrides?.limit !== undefined) config.setDailyTokenLimit(overrides.limit);
  const gateway = new AiGateway({
    configStore: config,
    usageStore: usage,
    mock: { requireFixture: overrides?.requireFixture, fixtures: overrides?.fixtures },
    retry: { retries: 3, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-02"
  });
  return { gateway, config, usage };
}

test("sampleFromSchema produces a parseable object for unions", () => {
  const sample = sampleFromSchema(decisionSchema);
  assert.doesNotThrow(() => decisionSchema.parse(sample));
});

test("fixture replay matches task + inputHash and errors clearly on miss", async () => {
  const input = { item_id: "item_1", title: "HITL" };
  const fixture: LlmFixture = {
    task: "knowledge_processing",
    promptVersion: "kp-v1",
    inputHash: hashInput(input),
    provider: "mock",
    model: "deterministic",
    input,
    output: { decision: "new", item_id: "item_1", name: "HITL", value_score: 0.9 },
    usage: { inputTokens: 10, outputTokens: 5 },
    recordedAt: "2026-10-02T00:00:00.000Z"
  };
  const { gateway } = setupGateway({ requireFixture: true, fixtures: [fixture] });
  const hit = await gateway.generateObject({
    task: "knowledge_processing",
    schema: decisionSchema,
    prompt: JSON.stringify(input),
    input,
    promptVersion: "kp-v1"
  });
  assert.equal(hit.object.decision, "new");
  assert.equal(hit.promptVersion, "kp-v1");

  await assert.rejects(
    () =>
      gateway.generateObject({
        task: "knowledge_processing",
        schema: decisionSchema,
        prompt: JSON.stringify({ item_id: "other" }),
        input: { item_id: "other" },
        promptVersion: "kp-v1"
      }),
    (error: unknown) => error instanceof FixtureNotFoundError && error.inputHash === hashInput({ item_id: "other" })
  );
});

test("mock rules and deterministic embedding are stable", async () => {
  const { gateway } = setupGateway();
  gateway.mockState.addRule({
    match: "item_npm",
    output: { decision: "reject", item_id: "item_npm", reason: "transient", value_score: 0.1 }
  });
  const result = await gateway.generateObject({
    task: "knowledge_processing",
    schema: decisionSchema,
    prompt: JSON.stringify({ item_id: "item_npm" }),
    promptVersion: "v1"
  });
  assert.equal(result.object.decision, "reject");

  const a = deterministicEmbedding("交叉编码器");
  const b = deterministicEmbedding("交叉编码器");
  const c = deterministicEmbedding("完全不同的文本");
  assert.deepEqual(a, b);
  assert.equal(a.length, 768);
  assert.notDeepEqual(a, c);

  const embedded = await gateway.embed({ value: "交叉编码器" });
  assert.deepEqual(embedded.embedding, a);
  assert.equal(embedded.dimensions, 768);
});

test("usage limit blocks calls unless allowOverLimit", async () => {
  const { gateway, usage } = setupGateway({ limit: 5 });
  usage.record({ day: "2026-10-02", task: "knowledge_processing", providerId: "mock", inputTokens: 3, outputTokens: 3 });
  await assert.rejects(
    () =>
      gateway.generateObject({
        task: "knowledge_processing",
        schema: decisionSchema,
        prompt: "{}",
        promptVersion: "v1"
      }),
    (error: unknown) => error instanceof UsageLimitExceededError
  );
  const allowed = await gateway.generateObject({
    task: "knowledge_processing",
    schema: decisionSchema,
    prompt: JSON.stringify({ item_id: "x" }),
    promptVersion: "v1",
    allowOverLimit: true
  });
  assert.ok(allowed.object);
});

test("429/5xx retries then switches to fallback model", async () => {
  const config = new MemoryProviderConfigStore();
  const usage = new MemoryUsageStore();
  config.upsertProvider({ id: "primary", name: "Primary", type: "mock", baseUrl: null, defaultModel: "p" });
  config.upsertProvider({ id: "fallback", name: "Fallback", type: "mock", baseUrl: null, defaultModel: "f" });
  config.setTaskModel({
    task: "learning_judge",
    providerId: "primary",
    model: "p",
    fallbackProviderId: "fallback",
    fallbackModel: "f"
  });

  const gateway = new AiGateway({
    configStore: config,
    usageStore: usage,
    retry: { retries: 3, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-02"
  });

  // Primary fails 4 times (1 try + 3 retries) → exhaust → fallback succeeds.
  gateway.mockState.scriptFailures("primary", 4, 429, "rate limited");
  gateway.mockState.addRule({
    match: () => true,
    output: { ok: true, from: "whichever" }
  });

  const result = await gateway.generateObject({
    task: "learning_judge",
    schema: z.object({ ok: z.boolean() }),
    prompt: '{"probe":true}',
    promptVersion: "v1"
  });
  assert.equal(result.object.ok, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.providerId, "fallback");
});

test("quota exhaustion (long retry hint) skips retries and cools the model down", async () => {
  const config = new MemoryProviderConfigStore();
  config.upsertProvider({ id: "primary", name: "Primary", type: "mock", baseUrl: null, defaultModel: "p" });
  config.upsertProvider({ id: "fallback", name: "Fallback", type: "mock", baseUrl: null, defaultModel: "f" });
  config.setTaskModel({ task: "learning_judge", providerId: "primary", model: "p", fallbackProviderId: "fallback", fallbackModel: "f" });
  const gateway = new AiGateway({
    configStore: config,
    usageStore: new MemoryUsageStore(),
    retry: { retries: 3, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-02"
  });
  gateway.mockState.scriptFailures("primary", 1, 429, "Quota exceeded for metric: free_tier_requests. Please retry in 8h13m38.76s.");
  gateway.mockState.addRule({ match: () => true, output: { ok: true } });
  const call = () => gateway.generateObject({ task: "learning_judge", schema: z.object({ ok: z.boolean() }), prompt: "{}", promptVersion: "v1" });

  assert.equal((await call()).usedFallback, true);
  assert.equal((await call()).usedFallback, true, "primary would succeed now, but is still cooling down");
});

test("AllModelsFailedError when primary and fallback both exhaust", async () => {
  const config = new MemoryProviderConfigStore();
  const usage = new MemoryUsageStore();
  config.upsertProvider({ id: "primary", name: "Primary", type: "mock", baseUrl: null, defaultModel: "p" });
  config.upsertProvider({ id: "fallback", name: "Fallback", type: "mock", baseUrl: null, defaultModel: "f" });
  config.setTaskModel({
    task: "learning_judge",
    providerId: "primary",
    model: "p",
    fallbackProviderId: "fallback",
    fallbackModel: "f"
  });
  const gateway = new AiGateway({
    configStore: config,
    usageStore: usage,
    retry: { retries: 1, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-02"
  });
  gateway.mockState.scriptFailures("primary", 10, 503);
  gateway.mockState.scriptFailures("fallback", 10, 503);
  await assert.rejects(
    () =>
      gateway.generateObject({
        task: "learning_judge",
        schema: z.object({ ok: z.boolean() }),
        prompt: "{}",
        promptVersion: "v1"
      }),
    (error: unknown) => error instanceof AllModelsFailedError && error.failures.length === 2
  );
});
