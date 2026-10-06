import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DatabaseSync } from "node:sqlite";
import {
  organizePreviewRequestSchema,
  organizeRunRequestSchema,
  organizeRunsQuerySchema,
  organizeSettingsUpdateSchema,
  type OrganizeEvent,
  type OrganizePreviewResponse,
  type OrganizeSettings,
  type OrganizeSettingsResponse,
  type OrganizeSettingsUpdate
} from "@study-studio/shared";
import type { AppServices } from "../app.js";
import { resolveTargets } from "../../domains/organize/pipeline.js";
import { failedTargets, getRunRow, lastFinishedAt, listRuns, runDetail, runSpecOf, toRunSummary, type RunSpec } from "../../domains/organize/run-store.js";
import { runTrace } from "../../domains/organize/trace.js";
import { readOrganizeSettings, writeOrganizeSettings } from "../../domains/organize/store.js";
import { organizeWorkerFor, OrganizeWorker } from "../../jobs/organize-worker.js";

const HEARTBEAT_MS = 15_000;

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function mergeSettings(current: OrganizeSettings, update: OrganizeSettingsUpdate): OrganizeSettings {
  return {
    autoEnabled: update.autoEnabled ?? current.autoEnabled,
    triggers: {
      daily: { ...current.triggers.daily, ...update.triggers?.daily },
      batch: { ...current.triggers.batch, ...update.triggers?.batch },
      onIngest: { ...current.triggers.onIngest, ...update.triggers?.onIngest }
    },
    outputLanguage: update.outputLanguage ?? current.outputLanguage
  };
}

function settingsResponse(db: DatabaseSync, worker: OrganizeWorker): OrganizeSettingsResponse {
  return {
    settings: readOrganizeSettings(db),
    lastRunAt: lastFinishedAt(db),
    nextRunAt: worker.nextDailyRunAt(),
    pendingCount: count(db, "SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND organize_status IN ('pending', 'failed')"),
    dirtyCount:
      count(db, "SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND dirty = 1 AND organize_status IN ('ingested', 'rejected')") +
      count(db, "SELECT COUNT(*) AS n FROM kb_entries WHERE deleted_at IS NULL AND (dirty = 1 OR stale = 1)"),
    activeRunId: worker.activeRunId()
  };
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

async function preview(db: DatabaseSync, spec: RunSpec, overLimit: () => boolean | Promise<boolean>): Promise<OrganizePreviewResponse> {
  const targets = resolveTargets(db, spec);
  const itemIds = [...targets.fullIds, ...targets.directIds];
  const entryIds = targets.rewriteIds;
  const inItems = itemIds.length ? placeholders(itemIds) : "NULL";
  const inEntries = entryIds.length ? placeholders(entryIds) : "NULL";
  const newItemCount = itemIds.length ? count(db, `SELECT COUNT(*) AS n FROM items WHERE id IN (${inItems}) AND organize_status = 'pending'`, ...itemIds) : 0;
  const editedItemCount = itemIds.length
    ? count(db, `SELECT COUNT(*) AS n FROM items WHERE id IN (${inItems}) AND dirty = 1 AND organize_status != 'pending'`, ...itemIds)
    : 0;
  const notesSql = `FROM notes WHERE deleted_at IS NULL AND ((scope = 'item' AND target_id IN (${inItems})) OR (scope = 'entry' AND target_id IN (${inEntries})))`;
  const noteParams = [...itemIds, ...entryIds];
  return {
    itemCount: itemIds.length,
    entryCount: entryIds.length,
    newItemCount,
    editedItemCount,
    noteCount: count(db, `SELECT COUNT(*) AS n ${notesSql}`, ...noteParams),
    newNoteCount: count(db, `SELECT COUNT(*) AS n ${notesSql} AND used_at IS NULL`, ...noteParams),
    fuzzyNoteCount: count(db, "SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND scope = 'fuzzy' AND used_at IS NULL"),
    overDailyLimit: Boolean(await overLimit())
  };
}

/** ORGANIZE_API (07 / 10). */
export function registerOrganizeRoutes(api: Hono, services: AppServices): void {
  const db = services.appDb.db;
  const worker = organizeWorkerFor(services);
  const overLimit = () => worker.isOverDailyLimit();

  api.get("/organize/settings", (c) => c.json(settingsResponse(db, worker)));

  api.put("/organize/settings", async (c) => {
    const parsed = organizeSettingsUpdateSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    try {
      writeOrganizeSettings(db, mergeSettings(readOrganizeSettings(db), parsed.data));
    } catch (error) {
      return c.json({ error: "invalid_request", message: error instanceof Error ? error.message : String(error) }, 400);
    }
    worker.reschedule();
    worker.checkTriggers();
    return c.json(settingsResponse(db, worker));
  });

  api.post("/organize/preview", async (c) => {
    const parsed = organizePreviewRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    const spec: RunSpec = { trigger: "manual", ...parsed.data, requirement: null, allowOverLimit: false };
    return c.json(await preview(db, spec, overLimit));
  });

  api.post("/organize/run", async (c) => {
    const parsed = organizeRunRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    const result = worker.enqueueManual(OrganizeWorker.specFromRequest(parsed.data));
    if ("conflict" in result) return c.json({ error: "run_in_progress", runId: result.conflict }, 409);
    return c.json({ run: toRunSummary(getRunRow(db, result.run.id) ?? result.run) }, 202);
  });

  api.get("/organize/runs", (c) => {
    const parsed = organizeRunsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return c.json(listRuns(db, parsed.data.cursor, parsed.data.limit));
  });

  api.get("/organize/runs/:id", (c) => {
    const detail = runDetail(db, c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404);
  });

  api.get("/organize/runs/:id/trace", (c) => {
    const row = getRunRow(db, c.req.param("id"));
    return row ? c.json({ steps: runTrace(db, row.id) }) : c.json({ error: "not_found" }, 404);
  });

  api.post("/organize/runs/:id/retry", (c) => {
    const row = getRunRow(db, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    const failed = failedTargets(db, row.id);
    if (failed.itemIds.length === 0 && failed.entryIds.length === 0) return c.json({ error: "no_failures" }, 422);
    const original = runSpecOf(row);
    const result = worker.enqueueManual({ ...original, trigger: "retry", itemIds: failed.itemIds, entryIds: failed.entryIds, requirement: null });
    if ("conflict" in result) return c.json({ error: "run_in_progress", runId: result.conflict }, 409);
    return c.json({ run: toRunSummary(getRunRow(db, result.run.id) ?? result.run) }, 202);
  });

  api.get("/organize/events", (c) =>
    streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const send = (event: OrganizeEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })).catch(() => undefined);
      };
      const unsubscribe = worker.subscribe(send);
      const heartbeat = setInterval(() => send({ type: "heartbeat", at: new Date().toISOString() }), HEARTBEAT_MS);
      send({ type: "heartbeat", at: new Date().toISOString() });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      unsubscribe();
      await chain;
    })
  );
}
