import type { DatabaseSync } from "node:sqlite";
import { SecretsFile } from "./secrets";
import {
  AI_TASKS,
  type AiTask,
  type ProviderConfig,
  type ProviderConfigStore,
  type ProviderType,
  type TaskModelConfig,
  type UsageIncrement,
  type UsageStore
} from "./types";

const LIMITS_KEY = "ai_limits";

export type ProviderStatus = "unconfigured" | "connected" | "error";

export type StoredProvider = ProviderConfig & {
  status: ProviderStatus;
  checkedAt: string | null;
};

export type ProviderInsert = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  defaultModel: string | null;
  apiKey?: string | null;
  status?: ProviderStatus;
};

/** `apiKey: null` clears, `undefined` keeps. */
export type ProviderUpdate = Partial<Omit<ProviderInsert, "id" | "status">>;

type ProviderRow = {
  id: string;
  name: string | null;
  type: string | null;
  base_url: string | null;
  default_model: string | null;
  status: string | null;
  checked_at: string | null;
};

type TaskRow = {
  task: string;
  provider_id: string | null;
  model: string | null;
  fallback_provider_id: string | null;
  fallback_model: string | null;
};

function toStatus(value: string | null): ProviderStatus {
  return value === "connected" || value === "error" ? value : "unconfigured";
}

/** providers / task_models tables + secrets.json + settings.ai_limits (06). */
export class SqliteAiConfigStore implements ProviderConfigStore {
  readonly db: DatabaseSync;
  readonly secrets: SecretsFile;

  constructor(db: DatabaseSync, secrets: SecretsFile) {
    this.db = db;
    this.secrets = secrets;
  }

  private fromRow(row: ProviderRow): StoredProvider {
    return {
      id: row.id,
      name: row.name ?? row.id,
      type: (row.type ?? "openai-compatible") as ProviderType,
      baseUrl: row.base_url,
      defaultModel: row.default_model,
      apiKey: this.secrets.getApiKey(row.id),
      status: toStatus(row.status),
      checkedAt: row.checked_at
    };
  }

  listProviders(): StoredProvider[] {
    const rows = this.db.prepare("SELECT * FROM providers ORDER BY rowid").all() as ProviderRow[];
    return rows.map((row) => this.fromRow(row));
  }

  getProvider(id: string): StoredProvider | null {
    const row = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  countProviders(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number };
    return Number(row.n);
  }

  insertProvider(input: ProviderInsert): StoredProvider {
    this.db
      .prepare("INSERT INTO providers (id, name, type, base_url, default_model, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(input.id, input.name, input.type, input.baseUrl, input.defaultModel, input.status ?? "unconfigured");
    if (input.apiKey !== undefined) this.secrets.setApiKey(input.id, input.apiKey);
    return this.getProvider(input.id)!;
  }

  /** Changing type / baseUrl / apiKey resets status to `unconfigured` until the next test. */
  updateProvider(id: string, update: ProviderUpdate): StoredProvider | null {
    const current = this.getProvider(id);
    if (!current) return null;
    const next = {
      name: update.name ?? current.name,
      type: update.type ?? current.type,
      baseUrl: update.baseUrl !== undefined ? update.baseUrl : current.baseUrl,
      defaultModel: update.defaultModel !== undefined ? update.defaultModel : current.defaultModel
    };
    const keyChanged = update.apiKey !== undefined && update.apiKey !== (current.apiKey ?? null);
    const connectionChanged = keyChanged || next.type !== current.type || next.baseUrl !== current.baseUrl;
    this.db
      .prepare(
        `UPDATE providers SET name = ?, type = ?, base_url = ?, default_model = ?
         ${connectionChanged ? ", status = 'unconfigured', checked_at = NULL" : ""} WHERE id = ?`
      )
      .run(next.name, next.type, next.baseUrl, next.defaultModel, id);
    if (keyChanged) this.secrets.setApiKey(id, update.apiKey ?? null);
    return this.getProvider(id);
  }

  deleteProvider(id: string): boolean {
    const result = this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    if (Number(result.changes) === 0) return false;
    this.secrets.setApiKey(id, null);
    return true;
  }

  setProviderStatus(id: string, status: ProviderStatus, checkedAt: string): void {
    this.db.prepare("UPDATE providers SET status = ?, checked_at = ? WHERE id = ?").run(status, checkedAt, id);
  }

  getTaskModel(task: AiTask): TaskModelConfig | null {
    const row = this.db.prepare("SELECT * FROM task_models WHERE task = ?").get(task) as TaskRow | undefined;
    if (!row?.provider_id || !row.model) return null;
    return {
      task,
      providerId: row.provider_id,
      model: row.model,
      fallbackProviderId: row.fallback_provider_id,
      fallbackModel: row.fallback_model
    };
  }

  listTaskModels(): TaskModelConfig[] {
    return AI_TASKS.map((task) => this.getTaskModel(task)).filter((config): config is TaskModelConfig => config !== null);
  }

  /** Tasks whose primary or fallback points at the provider. */
  tasksUsingProvider(providerId: string): AiTask[] {
    return this.listTaskModels()
      .filter((config) => config.providerId === providerId || config.fallbackProviderId === providerId)
      .map((config) => config.task);
  }

  setTaskModel(config: TaskModelConfig): void {
    this.db
      .prepare(
        `INSERT INTO task_models (task, provider_id, model, fallback_provider_id, fallback_model) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model,
           fallback_provider_id = excluded.fallback_provider_id, fallback_model = excluded.fallback_model`
      )
      .run(config.task, config.providerId, config.model, config.fallbackProviderId, config.fallbackModel);
  }

  getDailyTokenLimit(): number | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(LIMITS_KEY) as { value: string | null } | undefined;
    if (!row?.value) return null;
    try {
      const limit = (JSON.parse(row.value) as { dailyTokenLimit?: unknown }).dailyTokenLimit;
      return typeof limit === "number" && limit > 0 ? limit : null;
    } catch {
      return null;
    }
  }

  setDailyTokenLimit(limit: number | null): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(LIMITS_KEY, JSON.stringify({ dailyTokenLimit: limit }), new Date().toISOString());
  }
}

export type UsageRow = {
  task: AiTask;
  providerId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

/** `usage_daily` (day = UTC YYYY-MM-DD). */
export class SqliteUsageStore implements UsageStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getDayTotalTokens(day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total FROM usage_daily WHERE day = ?")
      .get(day) as { total: number };
    return Number(row.total);
  }

  record(increment: UsageIncrement): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, task, provider_id, calls, input_tokens, output_tokens) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(day, task, provider_id) DO UPDATE SET calls = COALESCE(calls, 0) + 1,
           input_tokens = COALESCE(input_tokens, 0) + excluded.input_tokens,
           output_tokens = COALESCE(output_tokens, 0) + excluded.output_tokens`
      )
      .run(increment.day, increment.task, increment.providerId, increment.inputTokens, increment.outputTokens);
  }

  listDay(day: string): UsageRow[] {
    const rows = this.db
      .prepare("SELECT task, provider_id, calls, input_tokens, output_tokens FROM usage_daily WHERE day = ? ORDER BY task, provider_id")
      .all(day) as { task: string; provider_id: string; calls: number | null; input_tokens: number | null; output_tokens: number | null }[];
    return rows
      .filter((row): row is typeof row & { task: AiTask } => (AI_TASKS as readonly string[]).includes(row.task))
      .map((row) => ({
        task: row.task,
        providerId: row.provider_id,
        calls: Number(row.calls ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0)
      }));
  }
}
