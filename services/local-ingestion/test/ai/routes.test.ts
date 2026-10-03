import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  AI_API,
  aiProviderSchema,
  aiProvidersResponseSchema,
  aiProviderTestResponseSchema,
  aiTasksResponseSchema,
  aiUsageResponseSchema
} from "@study-studio/shared";
import { UsageLimitExceededError } from "../../src/ai/errors.js";
import { importAiSeedIfEmpty } from "../../src/ai/seed.js";
import { utcDay } from "../../src/ai/stores.js";
import { createIngestionServer } from "../../src/create-server.js";
import { searchFts } from "../../src/search/fts.js";

const token = "ai-token";

async function start(options: { seed?: unknown; secrets?: unknown } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-ai-"));
  if (options.seed) writeFileSync(join(dataDir, "ai-seed.json"), JSON.stringify(options.seed));
  if (options.secrets) writeFileSync(join(dataDir, "secrets.json"), JSON.stringify(options.secrets), { mode: 0o600 });
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken: token,
    disableScheduler: true,
    skipVector: true,
    memory: true,
    ai: { retry: { retries: 0, baseDelayMs: 1, sleep: async () => {} } }
  });
  const port = await ingestion.listen(0);
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown, text };
  };
  return {
    dataDir,
    ingestion,
    call,
    async close() {
      await ingestion.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

test("provider CRUD masks API keys and keeps them in secrets.json (0600)", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call, dataDir } = server;

  const created = await call(
    AI_API.providers,
    json({ name: "DeepSeek", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-secret-abcd1234" })
  );
  assert.equal(created.status, 201);
  const provider = aiProviderSchema.parse(created.body);
  assert.equal(provider.apiKeyMasked, "sk-…1234");
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.status, "unconfigured");
  assert.ok(!created.text.includes("sk-secret-abcd1234"));

  const secretsPath = join(dataDir, "secrets.json");
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(secretsPath, "utf8")).providers[provider.id], { apiKey: "sk-secret-abcd1234" });
  const dbDump = JSON.stringify(server.ingestion.db.db.prepare("SELECT * FROM providers").all());
  assert.ok(!dbDump.includes("sk-secret"), "key must not be stored in SQLite");

  const listed = await call(AI_API.providers);
  const providers = aiProvidersResponseSchema.parse(listed.body).providers;
  assert.equal(providers.length, 1);
  assert.ok(!listed.text.includes("sk-secret-abcd1234"));

  const renamed = await call(AI_API.provider(provider.id), json({ name: "DeepSeek CN" }, "PATCH"));
  assert.equal(aiProviderSchema.parse(renamed.body).name, "DeepSeek CN");
  assert.equal(aiProviderSchema.parse(renamed.body).apiKeyMasked, "sk-…1234");

  const cleared = await call(AI_API.provider(provider.id), json({ apiKey: null }, "PATCH"));
  assert.equal(aiProviderSchema.parse(cleared.body).hasApiKey, false);
  assert.equal(JSON.parse(readFileSync(secretsPath, "utf8")).providers[provider.id], undefined);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);

  assert.equal((await call(AI_API.provider("missing"), json({ name: "x" }, "PATCH"))).status, 404);
  assert.equal((await call(AI_API.providers, json({ name: "", type: "mock" }))).status, 422);
  assert.equal((await call(AI_API.provider(provider.id), json({}, "PATCH"))).status, 422);

  const deleted = await call(AI_API.provider(provider.id), { method: "DELETE" });
  assert.deepEqual(deleted.body, { ok: true });
  assert.equal((await call(AI_API.provider(provider.id), { method: "DELETE" })).status, 404);
});

test("mock provider test connection updates status and lists models", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call } = server;
  const provider = aiProviderSchema.parse((await call(AI_API.providers, json({ name: "Mock", type: "mock" }))).body);

  const tested = aiProviderTestResponseSchema.parse((await call(AI_API.testProvider(provider.id), { method: "POST" })).body);
  assert.equal(tested.ok, true);
  assert.equal(tested.status, "connected");
  assert.ok(tested.models && tested.models.length > 0);
  const listed = aiProvidersResponseSchema.parse((await call(AI_API.providers)).body).providers[0]!;
  assert.equal(listed.status, "connected");
  assert.equal(listed.checkedAt, tested.checkedAt);

  // Connection-relevant edits invalidate the stored status.
  const patched = aiProviderSchema.parse((await call(AI_API.provider(provider.id), json({ apiKey: "mock-key-0000-1111" }, "PATCH"))).body);
  assert.equal(patched.status, "unconfigured");
  assert.equal((await call(AI_API.testProvider("missing"), { method: "POST" })).status, 404);
});

test("task models: every task listed, provider validated, in-use providers cannot be deleted", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call } = server;

  const empty = aiTasksResponseSchema.parse((await call(AI_API.tasks)).body);
  assert.deepEqual(
    empty.tasks.map((task) => task.task),
    ["learning_judge", "knowledge_processing", "entry_rewrite", "embedding", "chat"]
  );
  assert.ok(empty.tasks.every((task) => task.providerId === null));

  const main = aiProviderSchema.parse((await call(AI_API.providers, json({ name: "Main", type: "mock" }))).body);
  const backup = aiProviderSchema.parse((await call(AI_API.providers, json({ name: "Backup", type: "mock" }))).body);

  const unknown = await call(AI_API.tasks, json({ tasks: [{ task: "learning_judge", providerId: "nope", model: "m" }] }, "PUT"));
  assert.equal(unknown.status, 422);
  const badTask = await call(AI_API.tasks, json({ tasks: [{ task: "nonexistent", providerId: main.id, model: "m" }] }, "PUT"));
  assert.equal(badTask.status, 422);

  const saved = aiTasksResponseSchema.parse(
    (
      await call(
        AI_API.tasks,
        json(
          {
            tasks: [
              { task: "knowledge_processing", providerId: main.id, model: "deterministic", fallbackProviderId: backup.id, fallbackModel: "deterministic" },
              { task: "embedding", providerId: main.id, model: "deterministic-embed" }
            ]
          },
          "PUT"
        )
      )
    ).body
  );
  const kp = saved.tasks.find((task) => task.task === "knowledge_processing")!;
  assert.equal(kp.providerId, main.id);
  assert.equal(kp.fallbackProviderId, backup.id);
  assert.equal(saved.tasks.find((task) => task.task === "learning_judge")!.providerId, null);

  const providers = aiProvidersResponseSchema.parse((await call(AI_API.providers)).body).providers;
  assert.deepEqual(providers.find((p) => p.id === main.id)!.usedByTasks, ["knowledge_processing", "embedding"]);
  assert.deepEqual(providers.find((p) => p.id === backup.id)!.usedByTasks, ["knowledge_processing"]);

  const inUse = await call(AI_API.provider(backup.id), { method: "DELETE" });
  assert.equal(inUse.status, 409);
  assert.deepEqual(inUse.body, { error: "provider_in_use", tasks: ["knowledge_processing"] });

  // The gateway reads the same tables.
  const result = await server.ingestion.aiGateway.generateObject({
    task: "knowledge_processing",
    schema: z.object({ ok: z.boolean() }),
    prompt: "hello",
    promptVersion: "test-1"
  });
  assert.equal(result.providerId, main.id);
});

test("usage and daily limit: gateway calls recorded, blocked once over limit", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call, ingestion } = server;
  const provider = aiProviderSchema.parse((await call(AI_API.providers, json({ name: "Mock", type: "mock" }))).body);
  await call(AI_API.tasks, json({ tasks: [{ task: "learning_judge", providerId: provider.id, model: "deterministic" }] }, "PUT"));

  const before = aiUsageResponseSchema.parse((await call(AI_API.usage)).body);
  assert.equal(before.day, utcDay());
  assert.equal(before.totalTokens, 0);
  assert.equal(before.dailyTokenLimit, null);
  assert.equal(before.limitReached, false);

  const schema = z.object({ learning: z.boolean() });
  await ingestion.aiGateway.generateObject({ task: "learning_judge", schema, prompt: "first", promptVersion: "v1" });
  const after = aiUsageResponseSchema.parse((await call(AI_API.usage)).body);
  assert.equal(after.calls, 1);
  assert.ok(after.totalTokens > 0);
  assert.equal(after.rows[0]?.task, "learning_judge");
  assert.equal(after.rows[0]?.providerId, provider.id);

  const limits = await call(AI_API.limits, json({ dailyTokenLimit: 1 }, "PUT"));
  assert.deepEqual(limits.body, { dailyTokenLimit: 1 });
  const capped = aiUsageResponseSchema.parse((await call(AI_API.usage)).body);
  assert.equal(capped.dailyTokenLimit, 1);
  assert.equal(capped.limitReached, true);

  await assert.rejects(ingestion.aiGateway.generateObject({ task: "learning_judge", schema, prompt: "second", promptVersion: "v1" }), UsageLimitExceededError);
  // Manual runs may continue after confirmation.
  await ingestion.aiGateway.generateObject({ task: "learning_judge", schema, prompt: "third", promptVersion: "v1", allowOverLimit: true });

  assert.equal((await call(AI_API.limits, json({ dailyTokenLimit: 0 }, "PUT"))).status, 422);
  assert.deepEqual((await call(AI_API.limits, json({ dailyTokenLimit: null }, "PUT"))).body, { dailyTokenLimit: null });
  assert.equal((await call(`${AI_API.usage}?day=2026-1-1`)).status, 422);
  const otherDay = aiUsageResponseSchema.parse((await call(`${AI_API.usage}?day=2020-01-01`)).body);
  assert.equal(otherDay.calls, 0);
});

test("ai-seed.json is imported once when providers table is empty; keys come from secrets.json", async (t) => {
  const seed = {
    providers: [
      { id: "ollama", name: "Ollama（本地）", type: "ollama", base_url: "http://127.0.0.1:11434/api", default_model: "qwen2.5:7b" },
      { id: "groq", name: "Groq", type: "openai-compatible", base_url: "https://api.groq.com/openai/v1", default_model: "openai/gpt-oss-120b" }
    ],
    task_models: [
      { task: "learning_judge", provider_id: "ollama", model: "qwen2.5:7b", fallback_provider_id: "groq", fallback_model: "openai/gpt-oss-120b" },
      { task: "embedding", provider_id: "ollama", model: "nomic-embed-text", fallback_provider_id: null, fallback_model: null }
    ]
  };
  const server = await start({ seed, secrets: { providers: { groq: { apiKey: "gsk_seeded_key_9876" } } } });
  t.after(() => server.close());
  const providers = aiProvidersResponseSchema.parse((await server.call(AI_API.providers)).body).providers;
  assert.deepEqual(
    providers.map((p) => p.id),
    ["ollama", "groq"]
  );
  assert.equal(providers[1]!.apiKeyMasked, "gsk…9876");
  assert.equal(providers[0]!.hasApiKey, false);
  const tasks = aiTasksResponseSchema.parse((await server.call(AI_API.tasks)).body).tasks;
  assert.equal(tasks.find((task) => task.task === "learning_judge")!.fallbackProviderId, "groq");
  assert.equal(tasks.find((task) => task.task === "embedding")!.model, "nomic-embed-text");
  assert.equal(importAiSeedIfEmpty(server.ingestion.aiConfig, server.dataDir), null);
});

test("server wires search index + background chunk indexer with gateway embeddings", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { ingestion } = server;
  ingestion.aiConfig.insertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: null });
  ingestion.aiConfig.setTaskModel({ task: "embedding", providerId: "mock", model: "deterministic-embed", fallbackProviderId: null, fallbackModel: null });
  assert.equal(ingestion.searchIndex.vectorStore.backend, "memory");

  const db = ingestion.db.db;
  db.prepare("INSERT INTO kb_entries (id, name, summary, body_markdown) VALUES (?, ?, ?, ?)").run(
    "entry-1",
    "交叉编码器",
    "用于重排阶段的精排模型",
    "## 原理\n\ncross-encoder 同时编码查询与文档"
  );
  assert.equal(ingestion.chunkIndexer.backfill(), 1);
  await ingestion.chunkIndexer.idle();
  assert.ok(searchFts(db, "交叉编码器").some((hit) => hit.ownerId === "entry-1"));
  assert.ok(ingestion.searchIndex.vectorStore.size() > 0);

  // Re-indexing the same owner replaces its chunks (contentless FTS delete path).
  ingestion.chunkIndexer.enqueue({ ownerType: "entry", ownerId: "entry-1", text: "checkpoint persistence for interrupts" });
  await ingestion.chunkIndexer.idle();
  assert.ok(searchFts(db, "checkpoint").some((hit) => hit.ownerId === "entry-1"));
  assert.ok(!searchFts(db, "交叉编码器").some((hit) => hit.ownerId === "entry-1"));
  assert.equal(ingestion.chunkIndexer.backfill(), 0);

  // Without an embedding model the document is still keyword-searchable.
  db.prepare("DELETE FROM task_models").run();
  ingestion.chunkIndexer.enqueue({ ownerType: "entry", ownerId: "entry-2", text: "LangGraph human-in-the-loop" });
  await ingestion.chunkIndexer.idle();
  assert.ok(searchFts(db, "LangGraph").some((hit) => hit.ownerId === "entry-2"));
  assert.equal(existsSync(join(server.dataDir, "secrets.json")), false);
});
