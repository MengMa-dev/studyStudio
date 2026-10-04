import type { DatabaseSync } from "node:sqlite";
import type { OrganizeRunStats } from "@study-studio/shared";
import type { OrganizeRunRow } from "../../db/types.js";
import { activeRuns, createRun, getRunRow, toRunSummary, updateRun } from "../organize/run-store.js";
import { parseJson } from "../organize/store.js";
import { AgentToolError } from "./errors.js";

/** An agent session is an organize run with `trigger = "agent"`; last activity lives in `scope_ids.lastActiveAt`. */

export const AGENT_IDLE_MS = 30 * 60 * 1000;

function patchScopeIds(db: DatabaseSync, row: OrganizeRunRow, patch: Record<string, unknown>): void {
  const stored = parseJson<Record<string, unknown>>(row.scope_ids, {});
  db.prepare("UPDATE organize_runs SET scope_ids = ? WHERE id = ?").run(JSON.stringify({ ...stored, ...patch }), row.id);
}

export function runningAgentRun(db: DatabaseSync): OrganizeRunRow | null {
  return (db.prepare("SELECT * FROM organize_runs WHERE trigger = 'agent' AND status = 'running' ORDER BY rowid LIMIT 1").get() as OrganizeRunRow | undefined) ?? null;
}

export function startAgentSession(db: DatabaseSync, client: string | null): { ok: true; runId: string } | { ok: false; error: "busy"; activeRunId: string } {
  const active = activeRuns(db);
  const busy = active.find((run) => run.status === "running") ?? active[0];
  if (busy) return { ok: false, error: "busy", activeRunId: busy.id };
  const now = new Date().toISOString();
  const run = createRun(db, { trigger: "agent", scope: null, itemIds: [], entryIds: [], requirement: null, allowOverLimit: false });
  updateRun(db, run.id, { status: "running", startedAt: now, model: client ? `agent:${client}` : "agent" });
  patchScopeIds(db, run, { lastActiveAt: now });
  return { ok: true, runId: run.id };
}

export function requireAgentRun(db: DatabaseSync, runId: string): OrganizeRunRow {
  const row = getRunRow(db, runId);
  if (!row || row.trigger !== "agent" || row.status !== "running") {
    throw new AgentToolError("run_not_active", "会话不存在或已结束，请重新调用 start_session");
  }
  return row;
}

export function touchAgentRun(db: DatabaseSync, runId: string, now: string): void {
  const row = getRunRow(db, runId);
  if (row) patchScopeIds(db, row, { lastActiveAt: now });
}

export function finishAgentSession(db: DatabaseSync, runId: string, summary: string | null): OrganizeRunStats {
  const row = requireAgentRun(db, runId);
  if (summary) patchScopeIds(db, row, { summary });
  updateRun(db, runId, { status: "completed", finishedAt: new Date().toISOString(), progress: null });
  return toRunSummary(row).stats;
}

export function expireIdleAgentRuns(db: DatabaseSync, now: Date): number {
  const rows = db.prepare("SELECT * FROM organize_runs WHERE trigger = 'agent' AND status = 'running'").all() as OrganizeRunRow[];
  let expired = 0;
  for (const row of rows) {
    const lastActiveAt = parseJson<{ lastActiveAt?: string }>(row.scope_ids, {}).lastActiveAt ?? row.started_at;
    if (lastActiveAt && now.getTime() - Date.parse(lastActiveAt) < AGENT_IDLE_MS) continue;
    updateRun(db, row.id, { status: "completed", finishedAt: now.toISOString(), progress: null });
    expired += 1;
  }
  return expired;
}
