import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  organizeProgressSchema,
  organizeRunStatsSchema,
  organizeScopeSchema,
  organizeTriggerSchema,
  type OrganizeProgress,
  type OrganizeRunDetail,
  type OrganizeRunEntryChange,
  type OrganizeRunItem,
  type OrganizeRunStats,
  type OrganizeRunStatus,
  type OrganizeRunSummary,
  type OrganizeScope,
  type OrganizeTrigger
} from "@study-studio/shared";
import type { OrganizeJobRow, OrganizeRunRow } from "../../db/types.js";
import { parseJson, parseStringArray } from "./store.js";

/** `organize_runs` (queue + history) and `organize_jobs` (one row per item / entry target of a run). */

export type RunSpec = {
  trigger: OrganizeTrigger;
  scope: OrganizeScope | null;
  itemIds: string[];
  entryIds: string[];
  requirement: string | null;
  allowOverLimit: boolean;
};

type StoredScope = { itemIds?: string[]; entryIds?: string[]; allowOverLimit?: boolean };

export type JobKind = "item" | "entry_rewrite";
export type JobStatus = "pending" | "ingested" | "rejected" | "failed" | "skipped" | "deferred" | "rewritten";

export function emptyStats(): OrganizeRunStats {
  return {
    episodes: { learning: 0, notLearning: 0, deferred: 0 },
    items: { total: 0, ingested: 0, rejected: 0, failed: 0, skipped: 0 },
    decisions: { new: 0, supplement: 0, duplicate: 0, reject: 0, notLearning: 0, prefiltered: 0 },
    kb: { entriesCreated: 0, relationsCreated: 0, entriesSupplemented: 0, entriesRewritten: 0 },
    stages: []
  };
}

export function createRun(db: DatabaseSync, spec: RunSpec): OrganizeRunRow {
  const id = randomUUID();
  const scopeIds: StoredScope = { itemIds: spec.itemIds, entryIds: spec.entryIds, allowOverLimit: spec.allowOverLimit };
  db.prepare(
    `INSERT INTO organize_runs(id, trigger, scope, requirement, status, started_at, finished_at, stats, tokens, model, scope_ids, progress)
     VALUES (?, ?, ?, ?, 'queued', NULL, NULL, ?, 0, NULL, ?, NULL)`
  ).run(id, spec.trigger, spec.scope, spec.requirement, JSON.stringify(emptyStats()), JSON.stringify(scopeIds));
  return getRunRow(db, id)!;
}

export function getRunRow(db: DatabaseSync, id: string): OrganizeRunRow | null {
  return (db.prepare("SELECT * FROM organize_runs WHERE id = ?").get(id) as OrganizeRunRow | undefined) ?? null;
}

export function runSpecOf(row: OrganizeRunRow): RunSpec {
  const stored = parseJson<StoredScope>(row.scope_ids, {});
  const trigger = organizeTriggerSchema.safeParse(row.trigger);
  const scope = organizeScopeSchema.safeParse(row.scope);
  return {
    trigger: trigger.success ? trigger.data : "manual",
    scope: scope.success ? scope.data : null,
    itemIds: stored.itemIds ?? [],
    entryIds: stored.entryIds ?? [],
    requirement: row.requirement,
    allowOverLimit: Boolean(stored.allowOverLimit)
  };
}

export function activeRuns(db: DatabaseSync): OrganizeRunRow[] {
  return db.prepare("SELECT * FROM organize_runs WHERE status IN ('queued', 'running') ORDER BY rowid").all() as OrganizeRunRow[];
}

export function nextQueuedRun(db: DatabaseSync): OrganizeRunRow | null {
  return (db.prepare("SELECT * FROM organize_runs WHERE status = 'queued' ORDER BY rowid LIMIT 1").get() as OrganizeRunRow | undefined) ?? null;
}

export function updateRun(
  db: DatabaseSync,
  id: string,
  patch: Partial<{
    status: OrganizeRunStatus;
    startedAt: string;
    finishedAt: string | null;
    stats: OrganizeRunStats;
    tokens: number;
    model: string | null;
    progress: OrganizeProgress | null;
  }>
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
  if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
  if (patch.stats !== undefined) set("stats", JSON.stringify(patch.stats));
  if (patch.tokens !== undefined) set("tokens", patch.tokens);
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.progress !== undefined) set("progress", patch.progress ? JSON.stringify(patch.progress) : null);
  if (sets.length === 0) return;
  db.prepare(`UPDATE organize_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

/** Interrupted runs (crash / shutdown) go back to the queue; finished jobs are skipped by `input_hash`. Agent sessions cannot resume and are finished. */
export function requeueInterruptedRuns(db: DatabaseSync): number {
  db.prepare("UPDATE organize_runs SET status = 'completed', finished_at = ?, progress = NULL WHERE status = 'running' AND trigger = 'agent'").run(
    new Date().toISOString()
  );
  return Number(db.prepare("UPDATE organize_runs SET status = 'queued' WHERE status = 'running'").run().changes);
}

export function lastFinishedAt(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT MAX(finished_at) AS at FROM organize_runs WHERE status IN ('completed', 'paused', 'failed')").get() as { at: string | null };
  return row.at;
}

export function lastRunStartedAt(db: DatabaseSync, triggers: OrganizeTrigger[]): string | null {
  const placeholders = triggers.map(() => "?").join(",");
  const row = db.prepare(`SELECT MAX(started_at) AS at FROM organize_runs WHERE trigger IN (${placeholders})`).get(...triggers) as { at: string | null };
  return row.at;
}

function jobId(runId: string, kind: JobKind, targetId: string): string {
  return `${runId}:${kind}:${targetId}`;
}

export function setJob(db: DatabaseSync, runId: string, kind: JobKind, targetId: string, status: JobStatus, error: string | null = null): void {
  const id = jobId(runId, kind, targetId);
  const previousFailures = (
    db.prepare("SELECT COUNT(*) AS n FROM organize_jobs WHERE kind = ? AND target_id = ? AND status = 'failed' AND run_id != ?").get(kind, targetId, runId) as {
      n: number;
    }
  ).n;
  db.prepare(
    `INSERT INTO organize_jobs(id, run_id, kind, target_id, status, attempts, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, error = excluded.error, updated_at = excluded.updated_at`
  ).run(id, runId, kind, targetId, status, Number(previousFailures) + 1, error, new Date().toISOString());
}

export function runJobs(db: DatabaseSync, runId: string): OrganizeJobRow[] {
  return db.prepare("SELECT * FROM organize_jobs WHERE run_id = ? ORDER BY rowid").all(runId) as OrganizeJobRow[];
}

export function failedTargets(db: DatabaseSync, runId: string): { itemIds: string[]; entryIds: string[] } {
  const jobs = runJobs(db, runId).filter((job) => job.status === "failed" && job.target_id);
  return {
    itemIds: jobs.filter((job) => job.kind === "item").map((job) => job.target_id!),
    entryIds: jobs.filter((job) => job.kind === "entry_rewrite").map((job) => job.target_id!)
  };
}

export function toRunSummary(row: OrganizeRunRow): OrganizeRunSummary {
  const stats = organizeRunStatsSchema.safeParse(parseJson<unknown>(row.stats, null));
  const progress = organizeProgressSchema.safeParse(parseJson<unknown>(row.progress, null));
  const spec = runSpecOf(row);
  const status = (["queued", "running", "completed", "failed", "paused"] as const).find((value) => value === row.status) ?? "failed";
  return {
    id: row.id,
    trigger: spec.trigger,
    scope: spec.scope,
    requirement: row.requirement,
    status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    tokens: row.tokens ?? 0,
    model: row.model,
    stats: stats.success ? stats.data : emptyStats(),
    progress: progress.success ? progress.data : null
  };
}

export function listRuns(db: DatabaseSync, cursor: string | undefined, limit: number): { runs: OrganizeRunSummary[]; nextCursor: string | null } {
  const before = cursor && /^\d+$/.test(cursor) ? Number(cursor) : Number.MAX_SAFE_INTEGER;
  const rows = db.prepare("SELECT rowid AS _rowid, * FROM organize_runs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?").all(before, limit + 1) as Array<
    OrganizeRunRow & { _rowid: number }
  >;
  const page = rows.slice(0, limit);
  return { runs: page.map(toRunSummary), nextCursor: rows.length > limit ? String(page[page.length - 1]!._rowid) : null };
}

const ITEM_STATUSES = new Set(["pending", "ingested", "rejected", "failed", "skipped"]);
const DECISIONS = new Set(["new", "supplement", "duplicate", "reject", "not_learning"]);

export function runDetail(db: DatabaseSync, id: string): OrganizeRunDetail | null {
  const row = getRunRow(db, id);
  if (!row) return null;
  const jobs = runJobs(db, id);
  const selectItem = db.prepare(
    `SELECT i.title, i.type, r.decision, r.route, r.target_entry_ids, r.run_id, r.output FROM items i
     LEFT JOIN organize_results r ON r.item_id = i.id WHERE i.id = ?`
  );
  const items: OrganizeRunItem[] = [];
  const entries = new Map<string, OrganizeRunEntryChange>();
  const entryName = db.prepare("SELECT name FROM kb_entries WHERE id = ?");
  for (const job of jobs) {
    if (!job.target_id) continue;
    if (job.kind === "entry_rewrite") {
      if (job.status === "rewritten") {
        const name = (entryName.get(job.target_id) as { name: string } | undefined)?.name ?? job.target_id;
        entries.set(`${job.target_id}:rewritten`, { entryId: job.target_id, name, change: "rewritten" });
      }
      continue;
    }
    const item = selectItem.get(job.target_id) as
      | {
          title: string | null;
          type: OrganizeRunItem["type"];
          decision: string | null;
          route: string | null;
          target_entry_ids: string | null;
          run_id: string | null;
          output: string | null;
        }
      | undefined;
    const fromThisRun = item?.run_id === id;
    if (fromThisRun) {
      for (const change of parseJson<{ entry_changes?: OrganizeRunEntryChange[] }>(item?.output, {}).entry_changes ?? []) {
        entries.set(`${change.entryId}:${change.change}`, change);
      }
    }
    const status = job.status === "deferred" ? "pending" : (job.status ?? "pending");
    items.push({
      itemId: job.target_id,
      title: item?.title ?? job.target_id,
      type: item?.type ?? "webpage",
      status: (ITEM_STATUSES.has(status) ? status : "pending") as OrganizeRunItem["status"],
      decision: fromThisRun && item?.decision && DECISIONS.has(item.decision) ? (item.decision as OrganizeRunItem["decision"]) : null,
      route: fromThisRun ? (item?.route ?? null) : null,
      entryIds: fromThisRun ? parseStringArray(item?.target_entry_ids) : [],
      error: job.error
    });
  }
  return {
    ...toRunSummary(row),
    items,
    entries: [...entries.values()],
    failures: jobs
      .filter((job) => job.status === "failed")
      .map((job) => ({ jobId: job.id, kind: job.kind ?? "item", targetId: job.target_id, attempts: job.attempts ?? 1, error: job.error ?? "unknown error" }))
  };
}
