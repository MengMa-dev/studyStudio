import type { AiTask, ProviderConfig, ProviderConfigStore, TaskModelConfig, UsageIncrement, UsageStore } from "./types";

/** In-memory ProviderConfigStore for tests and offline demos. */
export class MemoryProviderConfigStore implements ProviderConfigStore {
  private providers = new Map<string, ProviderConfig>();
  private taskModels = new Map<AiTask, TaskModelConfig>();
  private dailyTokenLimit: number | null = null;

  upsertProvider(provider: ProviderConfig): void {
    this.providers.set(provider.id, { ...provider });
  }

  setTaskModel(config: TaskModelConfig): void {
    this.taskModels.set(config.task, { ...config });
  }

  setDailyTokenLimit(limit: number | null): void {
    this.dailyTokenLimit = limit;
  }

  getProvider(id: string): ProviderConfig | null {
    return this.providers.get(id) ?? null;
  }

  listProviders(): ProviderConfig[] {
    return [...this.providers.values()];
  }

  getTaskModel(task: AiTask): TaskModelConfig | null {
    return this.taskModels.get(task) ?? null;
  }

  getDailyTokenLimit(): number | null {
    return this.dailyTokenLimit;
  }
}

/** In-memory UsageStore; DB-backed usage_daily lands with the integration agent. */
export class MemoryUsageStore implements UsageStore {
  private byDayTaskProvider = new Map<string, UsageIncrement & { calls: number }>();

  private key(day: string, task: string, providerId: string): string {
    return `${day}\0${task}\0${providerId}`;
  }

  getDayTotalTokens(day: string): number {
    let total = 0;
    for (const row of this.byDayTaskProvider.values()) {
      if (row.day === day) total += row.inputTokens + row.outputTokens;
    }
    return total;
  }

  record(increment: UsageIncrement): void {
    const key = this.key(increment.day, increment.task, increment.providerId);
    const existing = this.byDayTaskProvider.get(key);
    if (existing) {
      existing.calls += 1;
      existing.inputTokens += increment.inputTokens;
      existing.outputTokens += increment.outputTokens;
      return;
    }
    this.byDayTaskProvider.set(key, { ...increment, calls: 1 });
  }

  /** Test helper: dump rows for a day. */
  listDay(day: string): (UsageIncrement & { calls: number })[] {
    return [...this.byDayTaskProvider.values()].filter((row) => row.day === day);
  }
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
