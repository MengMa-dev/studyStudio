import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  AI_TASK_NAMES,
  aiLimitsSchema,
  aiProviderCreateSchema,
  aiProviderPatchSchema,
  aiProviderTestRequestSchema,
  aiTasksUpdateSchema,
  aiUsageQuerySchema,
  type AiProvider,
  type AiTaskModel,
  type AiUsageResponse
} from "@study-studio/shared";
import type { z } from "zod";
import { maskApiKey, SecretsFile, secretsPathFor } from "../../ai/secrets.js";
import { SqliteAiConfigStore, SqliteUsageStore, type StoredProvider } from "../../ai/sqlite-stores.js";
import { utcDay } from "../../ai/stores.js";
import { testProviderConnection } from "../../ai/test-connection.js";
import type { AppServices } from "../app.js";

const TEST_TIMEOUT_MS = 30_000;

async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function invalid(c: Context, error: z.ZodError) {
  return c.json({ error: error.issues[0]?.message ?? "invalid_request" }, 422);
}

/** AI_API (06): providers CRUD, connection test, per-task models, usage and daily limit. */
export function registerAiRoutes(api: Hono, services: AppServices): void {
  const { appDb } = services;
  const config = services.aiConfig ?? new SqliteAiConfigStore(appDb.db, new SecretsFile(secretsPathFor(appDb.dataDir)));
  const usage = new SqliteUsageStore(appDb.db);

  const toResponse = (provider: StoredProvider): AiProvider => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKeyMasked: maskApiKey(provider.apiKey),
    hasApiKey: Boolean(provider.apiKey),
    status: provider.status,
    checkedAt: provider.checkedAt,
    usedByTasks: config.tasksUsingProvider(provider.id)
  });

  const listTasks = (): AiTaskModel[] =>
    AI_TASK_NAMES.map((task) => {
      const model = config.getTaskModel(task);
      return model ?? { task, providerId: null, model: null, fallbackProviderId: null, fallbackModel: null };
    });

  api.get("/ai/providers", (c) => c.json({ providers: config.listProviders().map(toResponse) }));

  api.post("/ai/providers", async (c) => {
    const raw = await readJson(c);
    if (!raw.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = aiProviderCreateSchema.safeParse(raw.body);
    if (!parsed.success) return invalid(c, parsed.error);
    const provider = config.insertProvider({
      id: randomUUID(),
      name: parsed.data.name,
      type: parsed.data.type,
      baseUrl: parsed.data.baseUrl ?? null,
      defaultModel: parsed.data.defaultModel ?? null,
      apiKey: parsed.data.apiKey ?? null
    });
    return c.json(toResponse(provider), 201);
  });

  api.patch("/ai/providers/:id", async (c) => {
    const raw = await readJson(c);
    if (!raw.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = aiProviderPatchSchema.safeParse(raw.body);
    if (!parsed.success) return invalid(c, parsed.error);
    const provider = config.updateProvider(c.req.param("id"), parsed.data);
    if (!provider) return c.json({ error: "not_found" }, 404);
    return c.json(toResponse(provider));
  });

  api.delete("/ai/providers/:id", (c) => {
    const id = c.req.param("id");
    if (!config.getProvider(id)) return c.json({ error: "not_found" }, 404);
    const tasks = config.tasksUsingProvider(id);
    if (tasks.length) return c.json({ error: "provider_in_use", tasks }, 409);
    config.deleteProvider(id);
    return c.json({ ok: true as const });
  });

  api.post("/ai/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const provider = config.getProvider(id);
    if (!provider) return c.json({ error: "not_found" }, 404);
    const raw = await readJson(c);
    if (!raw.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = aiProviderTestRequestSchema.safeParse(raw.body);
    if (!parsed.success) return invalid(c, parsed.error);
    const overrides = parsed.data;
    const result = await testProviderConnection(
      {
        ...provider,
        baseUrl: overrides.baseUrl ?? provider.baseUrl,
        apiKey: overrides.apiKey ?? provider.apiKey
      },
      { model: overrides.model, timeoutMs: TEST_TIMEOUT_MS }
    );
    const status = result.ok ? "connected" : "error";
    const checkedAt = new Date().toISOString();
    // Unsaved connection values are only probed; the stored status tracks the saved config.
    if (overrides.baseUrl === undefined && overrides.apiKey === undefined) config.setProviderStatus(id, status, checkedAt);
    return c.json({
      ok: result.ok,
      latencyMs: Math.max(0, Math.round(result.latencyMs)),
      ...(result.models ? { models: result.models } : {}),
      ...(result.error ? { error: result.error } : {}),
      status,
      checkedAt
    });
  });

  api.get("/ai/tasks", (c) => c.json({ tasks: listTasks() }));

  api.put("/ai/tasks", async (c) => {
    const raw = await readJson(c);
    if (!raw.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = aiTasksUpdateSchema.safeParse(raw.body);
    if (!parsed.success) return invalid(c, parsed.error);
    for (const task of parsed.data.tasks) {
      for (const providerId of [task.providerId, task.fallbackProviderId]) {
        if (providerId && !config.getProvider(providerId)) return c.json({ error: "provider_not_found", providerId }, 422);
      }
      if ((task.fallbackProviderId === null) !== (task.fallbackModel === null)) {
        return c.json({ error: "fallbackProviderId and fallbackModel must be set together" }, 422);
      }
    }
    for (const task of parsed.data.tasks) config.setTaskModel(task);
    return c.json({ tasks: listTasks() });
  });

  api.get("/ai/usage", (c) => {
    const parsed = aiUsageQuerySchema.safeParse({ day: c.req.query("day") });
    if (!parsed.success) return invalid(c, parsed.error);
    const day = parsed.data.day ?? utcDay();
    const rows = usage.listDay(day);
    const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const totalTokens = inputTokens + outputTokens;
    const dailyTokenLimit = config.getDailyTokenLimit();
    const body: AiUsageResponse = {
      day,
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      inputTokens,
      outputTokens,
      totalTokens,
      dailyTokenLimit,
      limitReached: dailyTokenLimit !== null && usage.getDayTotalTokens(day) >= dailyTokenLimit,
      rows
    };
    return c.json(body);
  });

  api.put("/ai/limits", async (c) => {
    const raw = await readJson(c);
    if (!raw.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = aiLimitsSchema.safeParse(raw.body);
    if (!parsed.success) return invalid(c, parsed.error);
    config.setDailyTokenLimit(parsed.data.dailyTokenLimit);
    return c.json({ dailyTokenLimit: config.getDailyTokenLimit() });
  });
}
