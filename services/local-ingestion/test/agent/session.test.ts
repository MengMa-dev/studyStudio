import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentToolError } from "../../src/domains/agent/errors";
import { AGENT_IDLE_MS, expireIdleAgentRuns, finishAgentSession, requireAgentRun, startAgentSession, touchAgentRun } from "../../src/domains/agent/session";
import { createRun, getRunRow, requeueInterruptedRuns, updateRun } from "../../src/domains/organize/run-store";
import { createEnv } from "../organize/helpers";

const manualSpec = { trigger: "manual" as const, scope: null, itemIds: [], entryIds: [], requirement: null, allowOverLimit: false };

test("no active run → agent run created and running; finish completes it", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const started = startAgentSession(env.db, "cursor");
  assert.ok(started.ok);
  const row = getRunRow(env.db, started.runId)!;
  assert.equal(row.trigger, "agent");
  assert.equal(row.status, "running");
  assert.ok(row.started_at);
  assert.equal(requireAgentRun(env.db, started.runId).id, started.runId);

  const stats = finishAgentSession(env.db, started.runId, "done");
  assert.equal(stats.items.total, 0);
  const finished = getRunRow(env.db, started.runId)!;
  assert.equal(finished.status, "completed");
  assert.ok(finished.finished_at);
  assert.throws(
    () => requireAgentRun(env.db, started.runId),
    (error) => error instanceof AgentToolError && error.code === "run_not_active"
  );
});

test("active run (worker or another agent session) → busy", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const queued = createRun(env.db, manualSpec);
  assert.deepEqual(startAgentSession(env.db, null), { ok: false, error: "busy", activeRunId: queued.id });
  updateRun(env.db, queued.id, { status: "completed" });

  const first = startAgentSession(env.db, "claude");
  assert.ok(first.ok);
  assert.deepEqual(startAgentSession(env.db, "codex"), { ok: false, error: "busy", activeRunId: first.runId });
});

test("idle agent run is finished after AGENT_IDLE_MS without writes", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const started = startAgentSession(env.db, null);
  assert.ok(started.ok);
  const base = Date.now();
  touchAgentRun(env.db, started.runId, new Date(base).toISOString());
  assert.equal(expireIdleAgentRuns(env.db, new Date(base + AGENT_IDLE_MS - 1000)), 0);
  assert.equal(getRunRow(env.db, started.runId)!.status, "running");

  const expired = expireIdleAgentRuns(env.db, new Date(base + AGENT_IDLE_MS + 1000));
  assert.equal(expired, 1);
  const row = getRunRow(env.db, started.runId)!;
  assert.equal(row.status, "completed");
  assert.ok(row.finished_at);
  assert.ok(startAgentSession(env.db, null).ok);
});

test("restart: running agent run is finished instead of requeued", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const started = startAgentSession(env.db, null);
  assert.ok(started.ok);
  const worker = createRun(env.db, manualSpec);
  updateRun(env.db, worker.id, { status: "running", startedAt: new Date().toISOString() });

  assert.equal(requeueInterruptedRuns(env.db), 1);
  const agent = getRunRow(env.db, started.runId)!;
  assert.equal(agent.status, "completed");
  assert.ok(agent.finished_at);
  assert.equal(getRunRow(env.db, worker.id)!.status, "queued");
});
