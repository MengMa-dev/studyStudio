import type { DatabaseSync } from "node:sqlite";
import type { OrganizeStage, OrganizeTraceStep } from "@study-studio/shared";
import { parseJson, parseStringArray } from "./store.js";

/** `organize_traces`: per-step input / output of a run for the run detail pipeline view. */

export type TraceScope = { itemIds: string[]; episodeId: string | null; entryId: string | null };

type TraceExtra = { model?: string | null; inputTokens?: number; outputTokens?: number; scope?: Partial<TraceScope> };

const EMPTY_SCOPE: TraceScope = { itemIds: [], episodeId: null, entryId: null };

const toJson = (value: unknown) => JSON.stringify(value ?? null, (_key, v) => (typeof v === "bigint" ? v.toString() : v));

export class TraceRecorder {
  /** Current work target; LLM calls inherit it. Units run serially, so a single mutable scope is enough. */
  scope: TraceScope = EMPTY_SCOPE;
  private seq: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly runId: string
  ) {
    const row = db.prepare("SELECT MAX(seq) AS seq FROM organize_traces WHERE run_id = ?").get(runId) as { seq: number | null };
    this.seq = row.seq ?? 0;
  }

  setScope(scope: Partial<TraceScope>): void {
    this.scope = { ...EMPTY_SCOPE, ...scope };
  }

  record(stage: OrganizeStage, step: string, input: unknown, output: unknown, extra: TraceExtra = {}): void {
    const scope = { ...this.scope, ...extra.scope };
    this.seq += 1;
    this.db
      .prepare(
        `INSERT INTO organize_traces(run_id, seq, stage, step, item_ids, episode_id, entry_id, input, output, model, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.runId,
        this.seq,
        stage,
        step,
        JSON.stringify(scope.itemIds),
        scope.episodeId,
        scope.entryId,
        toJson(input),
        toJson(output),
        extra.model ?? null,
        Math.round(extra.inputTokens ?? 0),
        Math.round(extra.outputTokens ?? 0),
        new Date().toISOString()
      );
  }
}

type TraceRow = {
  seq: number;
  stage: OrganizeStage;
  step: string;
  item_ids: string | null;
  episode_id: string | null;
  entry_id: string | null;
  input: string | null;
  output: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string | null;
};

export function runTrace(db: DatabaseSync, runId: string): OrganizeTraceStep[] {
  const rows = db.prepare("SELECT * FROM organize_traces WHERE run_id = ? ORDER BY seq").all(runId) as TraceRow[];
  return rows.map((row) => ({
    seq: row.seq,
    stage: row.stage,
    step: row.step,
    itemIds: parseStringArray(row.item_ids),
    episodeId: row.episode_id,
    entryId: row.entry_id,
    input: parseJson<unknown>(row.input, null),
    output: parseJson<unknown>(row.output, null),
    model: row.model,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    createdAt: row.created_at
  }));
}
