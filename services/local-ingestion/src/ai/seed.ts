import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteAiConfigStore } from "./sqlite-stores";
import { AI_TASKS, PROVIDER_TYPES, type AiTask, type ProviderType } from "./types";

export const AI_SEED_FILE = "ai-seed.json";

/** Written by `npm run setup:ai` (scripts/setup-dev-ai.js); keys go to secrets.json separately. */
type AiSeed = {
  providers?: { id?: string; name?: string; type?: string; base_url?: string | null; default_model?: string | null }[];
  task_models?: {
    task?: string;
    provider_id?: string;
    model?: string;
    fallback_provider_id?: string | null;
    fallback_model?: string | null;
  }[];
};

export type AiSeedImport = { providers: number; tasks: number };

/** Import `ai-seed.json` only while the providers table is empty (06). Returns null when skipped. */
export function importAiSeedIfEmpty(store: SqliteAiConfigStore, dataDir: string | null): AiSeedImport | null {
  if (!dataDir || store.countProviders() > 0) return null;
  const path = join(dataDir, AI_SEED_FILE);
  if (!existsSync(path)) return null;
  let seed: AiSeed;
  try {
    seed = JSON.parse(readFileSync(path, "utf8")) as AiSeed;
  } catch {
    return null;
  }

  const imported = new Set<string>();
  for (const provider of seed.providers ?? []) {
    if (!provider.id || !PROVIDER_TYPES.includes(provider.type as ProviderType)) continue;
    store.insertProvider({
      id: provider.id,
      name: provider.name ?? provider.id,
      type: provider.type as ProviderType,
      baseUrl: provider.base_url ?? null,
      defaultModel: provider.default_model ?? null
    });
    imported.add(provider.id);
  }

  let tasks = 0;
  for (const config of seed.task_models ?? []) {
    if (!AI_TASKS.includes(config.task as AiTask) || !config.provider_id || !config.model || !imported.has(config.provider_id)) continue;
    const fallbackOk = Boolean(config.fallback_provider_id && config.fallback_model && imported.has(config.fallback_provider_id));
    store.setTaskModel({
      task: config.task as AiTask,
      providerId: config.provider_id,
      model: config.model,
      fallbackProviderId: fallbackOk ? config.fallback_provider_id! : null,
      fallbackModel: fallbackOk ? config.fallback_model! : null
    });
    tasks += 1;
  }
  return { providers: imported.size, tasks };
}
