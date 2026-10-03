import type { DatabaseSync } from "node:sqlite";
import type { OrganizeStage, OrganizeStageUsage } from "@study-studio/shared";
import type { AiGateway } from "../../ai/gateway.js";
import type { SearchIndex } from "../../search/index-api.js";

/** The slice of the AI gateway the pipeline needs; tests inject an `AiGateway` with the mock provider. */
export type OrganizeGateway = Pick<AiGateway, "generateObject" | "embed">;

export type OrganizeDeps = {
  db: DatabaseSync;
  /** Null when no AI provider is configured: runs fail up front. */
  gateway: OrganizeGateway | null;
  /** Null disables vector recall and entry indexing (FTS-free name matching still works). */
  searchIndex: SearchIndex | null;
  now?: () => Date;
};

/** Chunk owner types written by the organize pipeline (`chunks.owner_type`). */
export const ENTRY_OWNER = {
  /** Name + aliases + summary: synchronously refreshed so the next item's ④ sees it. */
  summary: "entry_summary",
  /** Name + aliases only: used for the 0.92 name-embedding alignment in ⑥. */
  name: "entry_name",
  /** Body chunks (07: `owner_type=entry`), refreshed after the batch. */
  body: "entry"
} as const;

/** Accumulates per-stage LLM usage for `organize_runs.stats.stages` / `tokens` / `model`. */
export class UsageTracker {
  private readonly stages = new Map<OrganizeStage, OrganizeStageUsage>();
  private readonly models = new Map<string, number>();

  record(stage: OrganizeStage, usage: { inputTokens: number; outputTokens: number }, model?: string): void {
    const current = this.stages.get(stage) ?? { stage, calls: 0, inputTokens: 0, outputTokens: 0 };
    current.calls += 1;
    current.inputTokens += Math.max(0, Math.round(usage.inputTokens));
    current.outputTokens += Math.max(0, Math.round(usage.outputTokens));
    this.stages.set(stage, current);
    if (model) this.models.set(model, (this.models.get(model) ?? 0) + 1);
  }

  list(): OrganizeStageUsage[] {
    return [...this.stages.values()];
  }

  totalTokens(): number {
    let total = 0;
    for (const stage of this.stages.values()) total += stage.inputTokens + stage.outputTokens;
    return total;
  }

  /** Most used model, preferring knowledge processing (the expensive call). */
  primaryModel(): string | null {
    let best: string | null = null;
    let count = -1;
    for (const [model, calls] of this.models) {
      if (calls > count) {
        best = model;
        count = calls;
      }
    }
    return best;
  }
}
