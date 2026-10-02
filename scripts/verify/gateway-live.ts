/**
 * Optional live check of the M4 AI gateway against real providers.
 * Reads ai-seed.json + secrets.json from STUDY_STUDIO_DATA_DIR (default ./StudyStudioData).
 * Skips with a clear message when keys are missing (cloud agents usually have none).
 *
 * Usage: npx tsx scripts/verify/gateway-live.ts
 */
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AiGateway } from "../../services/local-ingestion/src/ai/gateway";
import { MemoryProviderConfigStore, MemoryUsageStore } from "../../services/local-ingestion/src/ai/stores";
import type { ProviderConfig, ProviderType, TaskModelConfig } from "../../services/local-ingestion/src/ai/types";
import { testProviderConnection } from "../../services/local-ingestion/src/ai/test-connection";

const root = resolve(import.meta.dirname, "../..");
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");

const probeSchema = z.object({
  ok: z.boolean(),
  echo: z.string()
});

type Seed = {
  providers: { id: string; name?: string; type: string; base_url: string; default_model?: string }[];
  task_models: {
    task: string;
    provider_id: string;
    model: string;
    fallback_provider_id: string | null;
    fallback_model: string | null;
  }[];
};

async function main(): Promise<void> {
  const seedPath = join(dataDir, "ai-seed.json");
  const secretsPath = join(dataDir, "secrets.json");
  try {
    await access(seedPath);
  } catch {
    console.log(`SKIP  gateway-live: missing ${seedPath} (run npm run setup:ai first, or set STUDY_STUDIO_DATA_DIR)`);
    return;
  }

  const seed = JSON.parse(await readFile(seedPath, "utf8")) as Seed;
  const secrets = JSON.parse(await readFile(secretsPath, "utf8").catch(() => "{}")) as {
    providers?: Record<string, { apiKey?: string }>;
  };

  const cloudProviders = seed.providers.filter((p) => p.type !== "ollama" && p.type !== "mock");
  const hasAnyKey = cloudProviders.some((p) => Boolean(secrets.providers?.[p.id]?.apiKey));
  if (!hasAnyKey) {
    console.log("SKIP  gateway-live: no API keys in secrets.json (cloud environment without credentials)");
    return;
  }

  const config = new MemoryProviderConfigStore();
  for (const row of seed.providers) {
    const provider: ProviderConfig = {
      id: row.id,
      name: row.name ?? row.id,
      type: row.type as ProviderType,
      baseUrl: row.base_url,
      defaultModel: row.default_model ?? null,
      apiKey: secrets.providers?.[row.id]?.apiKey ?? null
    };
    config.upsertProvider(provider);
    if (provider.type === "ollama" || provider.apiKey) {
      const test = await testProviderConnection(provider, { timeoutMs: 60_000 });
      console.log(
        `${test.ok ? "PASS" : "FAIL"}  test ${provider.id}  ${test.latencyMs}ms  models=${test.models?.length ?? 0}${test.error ? `  ${test.error}` : ""}`
      );
    }
  }
  for (const row of seed.task_models) {
    if (!["learning_judge", "knowledge_processing", "entry_rewrite", "embedding"].includes(row.task)) continue;
    config.setTaskModel({
      task: row.task as TaskModelConfig["task"],
      providerId: row.provider_id,
      model: row.model,
      fallbackProviderId: row.fallback_provider_id,
      fallbackModel: row.fallback_model
    });
  }

  const gateway = new AiGateway({
    configStore: config,
    usageStore: new MemoryUsageStore(),
    retry: { retries: 2, baseDelayMs: 500 }
  });

  const task = seed.task_models.find((row) => row.task === "learning_judge");
  if (!task) {
    console.log("SKIP  no learning_judge task in ai-seed.json");
    return;
  }

  try {
    const result = await gateway.generateObject({
      task: "learning_judge",
      schema: probeSchema,
      system: "只输出 JSON：{ ok: true, echo: 用户内容原文 }。",
      prompt: "ping-gateway",
      promptVersion: "gateway-live-v1"
    });
    console.log(`PASS  generateObject via ${result.providerId}/${result.model} →`, result.object);
  } catch (error) {
    console.log(`FAIL  generateObject: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

await main();
