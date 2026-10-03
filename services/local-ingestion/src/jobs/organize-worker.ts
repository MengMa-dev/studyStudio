import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";
import type { OrganizeEvent, OrganizeRunRequest, OrganizeTrigger } from "@study-studio/shared";
import { SqliteUsageStore } from "../ai/sqlite-stores.js";
import { utcDay } from "../ai/stores.js";
import type { AppDatabase } from "../db/database.js";
import type { OrganizeRunRow } from "../db/types.js";
import { executeRun, OrganizeAbortedError } from "../domains/organize/pipeline.js";
import {
  activeRuns,
  createRun,
  getRunRow,
  lastRunStartedAt,
  nextQueuedRun,
  requeueInterruptedRuns,
  runJobs,
  runSpecOf,
  toRunSummary,
  updateRun,
  type RunSpec
} from "../domains/organize/run-store.js";
import type { OrganizeGateway } from "../domains/organize/runtime-types.js";
import { parseJson, readOrganizeSettings } from "../domains/organize/store.js";
import type { SearchIndex } from "../search/index-api.js";

/**
 * Single organize worker per database: `organize_runs` is the persistent queue (one run at a time),
 * `organize_jobs` tracks per-item / per-entry targets. Triggers: daily cron, batch count, on-ingest (polled),
 * manual / retry via the API, catch-up after missed schedules, next-day resume of paused runs.
 */

export type OrganizeWorkerOptions = {
  db: DatabaseSync;
  getGateway: () => OrganizeGateway | null;
  getSearchIndex: () => SearchIndex | null;
  /** Daily token limit state for the manual dialog preview; defaults to false when unknown. */
  isOverDailyLimit?: () => boolean | Promise<boolean>;
  now?: () => Date;
  /** Batch / on-ingest polling interval (ingest has no hook into the worker). */
  pollIntervalMs?: number;
};

export type OrganizeListener = (event: OrganizeEvent) => void;

export type EnqueueResult = { run: OrganizeRunRow; merged: boolean };

const AUTO_TRIGGERS: OrganizeTrigger[] = ["daily", "batch", "on_ingest", "catch_up"];
const DEFAULT_POLL_MS = 60_000;
const RESUME_CRON = "5 0 * * *";

function dailyPattern(time: string): string {
  const [hh, mm] = time.split(":");
  return `${Number(mm)} ${Number(hh)} * * *`;
}

/** Most recent scheduled HH:mm (local) at or before `now`. */
export function lastScheduledAt(time: string, now: Date): Date {
  const [hh, mm] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hh ?? 0, mm ?? 0, 0, 0);
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
  return at;
}

function startOfLocalDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

export class OrganizeWorker {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<OrganizeListener>();
  private crons: Cron[] = [];
  private poll: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private started = false;
  private stopping = false;

  constructor(private options: OrganizeWorkerOptions) {
    this.db = options.db;
  }

  /** Swap dependency getters (routes are registered before create-server injects services). */
  configure(partial: Partial<Omit<OrganizeWorkerOptions, "db">>): void {
    this.options = { ...this.options, ...partial };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  subscribe(listener: OrganizeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OrganizeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  async isOverDailyLimit(): Promise<boolean> {
    try {
      return Boolean(await this.options.isOverDailyLimit?.());
    } catch {
      return false;
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    this.stopping = false;
    requeueInterruptedRuns(this.db);
    this.reschedule();
    this.crons.push(new Cron(RESUME_CRON, { protect: true }, () => this.resumePausedRuns()));
    this.poll = setInterval(() => this.checkTriggers(), this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.poll.unref?.();
    this.resumePausedRuns();
    this.catchUp();
    this.checkTriggers();
    this.kick();
    return this;
  }

  /** Stops triggers, aborts the current run (it goes back to the queue) and waits for the loop. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    for (const cron of this.crons) cron.stop();
    this.crons = [];
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.stopping = false;
  }

  /** Re-reads settings and rebuilds the daily cron. */
  reschedule(): void {
    for (const cron of this.crons.splice(0)) {
      if (cron.name === "organize-daily") cron.stop();
      else this.crons.push(cron);
    }
    if (!this.started) return;
    const settings = readOrganizeSettings(this.db);
    if (!settings.autoEnabled || !settings.triggers.daily.enabled) return;
    this.crons.push(
      new Cron(dailyPattern(settings.triggers.daily.time), { name: "organize-daily", protect: true }, () => {
        this.enqueueAuto("daily");
      })
    );
  }

  nextDailyRunAt(): string | null {
    const settings = readOrganizeSettings(this.db);
    if (!settings.autoEnabled || !settings.triggers.daily.enabled) return null;
    const cron = new Cron(dailyPattern(settings.triggers.daily.time), { paused: true });
    const next = cron.nextRun(this.now());
    cron.stop();
    return next ? next.toISOString() : null;
  }

  activeRunId(): string | null {
    const active = activeRuns(this.db);
    return (active.find((run) => run.status === "running") ?? active[0])?.id ?? null;
  }

  private hasAutoWork(): boolean {
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND organize_status IN ('pending', 'failed')").get() as {
      n: number;
    };
    if (Number(pending.n) > 0) return true;
    const stale = this.db.prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE deleted_at IS NULL AND stale = 1").get() as { n: number };
    return Number(stale.n) > 0;
  }

  /** Automatic triggers merge into an already queued automatic run. */
  enqueueAuto(trigger: OrganizeTrigger, itemIds: string[] = []): EnqueueResult | null {
    const settings = readOrganizeSettings(this.db);
    if (!settings.autoEnabled || this.stopping) return null;
    const queued = activeRuns(this.db).find((run) => run.status === "queued" && run.scope === null);
    if (queued) return { run: queued, merged: true };
    if (itemIds.length === 0 && !this.hasAutoWork()) return null;
    const run = createRun(this.db, { trigger, scope: null, itemIds, entryIds: [], requirement: null, allowOverLimit: false });
    this.kick();
    return { run, merged: false };
  }

  /** Manual / retry runs; returns the active run instead when one is queued or running. */
  enqueueManual(spec: RunSpec): { run: OrganizeRunRow } | { conflict: string } {
    const active = this.activeRunId();
    if (active) return { conflict: active };
    if (spec.requirement) this.saveRequirementNote(spec);
    const run = createRun(this.db, spec);
    this.kick();
    return { run };
  }

  /** 07: the requirement is saved as a note by scope (item / entry / fuzzy `origin=organize_requirement`). */
  private saveRequirementNote(spec: RunSpec): void {
    const now = this.now().toISOString();
    const [scope, target] =
      spec.scope === "item"
        ? (["item", spec.itemIds[0] ?? null] as const)
        : spec.scope === "entry"
          ? (["entry", spec.entryIds[0] ?? null] as const)
          : (["fuzzy", null] as const);
    this.db
      .prepare("INSERT INTO notes(id, scope, target_id, text, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'organize_requirement', ?, ?)")
      .run(randomUUID(), scope, target, spec.requirement, now, now);
  }

  static specFromRequest(request: OrganizeRunRequest): RunSpec {
    return {
      trigger: "manual",
      scope: request.scope,
      itemIds: request.itemIds,
      entryIds: request.entryIds,
      requirement: request.requirement?.trim() || null,
      allowOverLimit: request.allowOverLimit
    };
  }

  /** Batch (N new pending items since the last automatic run) and on-ingest triggers. */
  checkTriggers(): void {
    const settings = readOrganizeSettings(this.db);
    if (!settings.autoEnabled) return;
    const since = lastRunStartedAt(this.db, AUTO_TRIGGERS) ?? "";
    const fresh = Number(
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND organize_status = 'pending' AND captured_at > ?").get(since) as {
          n: number;
        }
      ).n
    );
    if (settings.triggers.batch.enabled && fresh >= settings.triggers.batch.count) this.enqueueAuto("batch");
    else if (settings.triggers.onIngest.enabled && fresh > 0) this.enqueueAuto("on_ingest");
  }

  /** Missed daily schedule while the service was down → one catch-up run. */
  catchUp(): void {
    const settings = readOrganizeSettings(this.db);
    if (!settings.autoEnabled || !settings.triggers.daily.enabled) return;
    const scheduled = lastScheduledAt(settings.triggers.daily.time, this.now());
    const last = lastRunStartedAt(this.db, ["daily", "catch_up"]);
    if (last && Date.parse(last) >= scheduled.getTime()) return;
    this.enqueueAuto("catch_up");
  }

  /** Paused (daily limit) runs continue the next day with their unfinished items. */
  resumePausedRuns(): void {
    const today = startOfLocalDay(this.now()).toISOString();
    const paused = this.db.prepare("SELECT * FROM organize_runs WHERE status = 'paused' AND finished_at < ?").all(today) as OrganizeRunRow[];
    for (const run of paused) {
      const stored = parseJson<Record<string, unknown>>(run.scope_ids, {});
      if (stored.resumed) continue;
      const spec = runSpecOf(run);
      const remaining = runJobs(this.db, run.id)
        .filter((job) => job.kind === "item" && (job.status === "pending" || job.status === "deferred") && job.target_id)
        .map((job) => job.target_id!);
      this.db.prepare("UPDATE organize_runs SET scope_ids = ? WHERE id = ?").run(JSON.stringify({ ...stored, resumed: true }), run.id);
      if (activeRuns(this.db).length > 0 && spec.scope === null) continue;
      createRun(this.db, { ...spec, trigger: "catch_up", itemIds: remaining.length ? remaining : spec.itemIds, allowOverLimit: false });
    }
    if (paused.length) this.kick();
  }

  /** Starts the processing loop if idle. Safe to call any time. */
  kick(): void {
    if (this.loop || this.stopping) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
      if (!this.stopping && nextQueuedRun(this.db)) this.kick();
    });
  }

  /** Resolves when the queue is empty (tests / shutdown). */
  async whenIdle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  private async drain(): Promise<void> {
    for (let run = nextQueuedRun(this.db); run && !this.stopping; run = nextQueuedRun(this.db)) {
      await this.process(run);
    }
  }

  private async process(row: OrganizeRunRow): Promise<void> {
    const runId = row.id;
    const spec = runSpecOf(row);
    const startedAt = row.started_at ?? this.now().toISOString();
    updateRun(this.db, runId, { status: "running", startedAt, progress: { stage: "context", done: 0, total: 0 } });
    this.emit({ type: "run_started", runId, trigger: spec.trigger, scope: spec.scope, total: 0 });
    this.abort = new AbortController();
    let lastProgressWrite = 0;
    try {
      const result = await executeRun(
        { db: this.db, gateway: this.options.getGateway(), searchIndex: this.options.getSearchIndex(), now: this.options.now },
        runId,
        spec,
        {
          onProgress: (progress) => {
            const nowMs = Date.now();
            if (nowMs - lastProgressWrite > 250 || progress.done === progress.total) {
              lastProgressWrite = nowMs;
              updateRun(this.db, runId, { progress: { stage: progress.stage, done: progress.done, total: progress.total } });
            }
            this.emit({ type: "run_progress", runId, ...progress });
          },
          onItemDone: (event) => this.emit({ type: "item_done", runId, ...event })
        },
        this.abort.signal
      );
      updateRun(this.db, runId, {
        status: result.status,
        finishedAt: this.now().toISOString(),
        stats: result.stats,
        tokens: result.tokens,
        model: result.model,
        progress: null
      });
      if (result.status === "paused") this.emit({ type: "run_paused", runId, reason: "daily_limit" });
      this.emit({ type: "run_finished", runId, status: result.status, stats: result.stats });
    } catch (error) {
      if (error instanceof OrganizeAbortedError) {
        updateRun(this.db, runId, { status: "queued", progress: null });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateRun(this.db, runId, { status: "failed", finishedAt: this.now().toISOString(), progress: null });
      this.emit({ type: "run_failed", runId, error: message });
    } finally {
      this.abort = null;
    }
  }

  summary(runId: string) {
    const row = getRunRow(this.db, runId);
    return row ? toRunSummary(row) : null;
  }
}

type WorkerServices = {
  appDb: AppDatabase;
  aiGateway?: OrganizeGateway;
  searchIndex?: SearchIndex;
  aiConfig?: { getDailyTokenLimit(): number | null };
};

function dailyLimitCheck(services: WorkerServices): (() => boolean) | undefined {
  const { aiConfig } = services;
  if (!aiConfig) return undefined;
  const usage = new SqliteUsageStore(services.appDb.db);
  return () => {
    const limit = aiConfig.getDailyTokenLimit();
    return limit !== null && usage.getDayTotalTokens(utcDay()) >= limit;
  };
}

const registry = new WeakMap<DatabaseSync, OrganizeWorker>();

/** One worker per database; dependency getters read the services object lazily. */
export function organizeWorkerFor(services: WorkerServices): OrganizeWorker {
  const existing = registry.get(services.appDb.db);
  if (existing) return existing;
  const worker = new OrganizeWorker({
    db: services.appDb.db,
    getGateway: () => services.aiGateway ?? null,
    getSearchIndex: () => services.searchIndex ?? null,
    isOverDailyLimit: dailyLimitCheck(services)
  });
  registry.set(services.appDb.db, worker);
  return worker;
}

/** create-server hook: start triggers for the worker registered by the organize routes. */
export function startOrganizeWorker(appDb: AppDatabase): OrganizeWorker {
  return organizeWorkerFor({ appDb }).start();
}
