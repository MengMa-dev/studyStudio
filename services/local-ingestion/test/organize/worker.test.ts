import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  ORGANIZE_API,
  organizeRunDetailSchema,
  organizeRunsResponseSchema,
  organizeSettingsResponseSchema,
  type OrganizeEvent,
  type OrganizeSettings
} from "@study-studio/shared";
import { PresenceStore } from "../../src/domains/capture/presence";
import { createRun, getRunRow, runDetail, setJob, updateRun } from "../../src/domains/organize/run-store";
import { writeOrganizeSettings } from "../../src/domains/organize/store";
import { createApp, createAuthState } from "../../src/http/app";
import { OrganizeWorker, organizeWorkerFor } from "../../src/jobs/organize-worker";
import {
  NOW,
  createEnv,
  createReplayGateway,
  entry,
  insertEntry,
  insertItem,
  insertSource,
  itemStatus,
  output,
  recordedContent,
  recordedTurns,
  replay,
  steps,
  setLearnerProfile,
  type TestEnv
} from "./helpers";

const T = (minutes: number) => new Date(Date.parse("2026-10-02T12:00:00.000Z") + minutes * 60_000).toISOString();

function seed(env: TestEnv): void {
  setLearnerProfile(env.db);
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", aliases: ["HITL"], body: "## 定义\n人工审批节点。", category: "Agent 框架" });
  insertEntry(env.db, { id: "kb_checkpoint", name: "Checkpoint", aliases: ["checkpointer"], body: "## 定义\n状态快照。", category: "Agent 框架" });
  insertItem(env.db, { id: "item_hitl_blog", title: "用 LangGraph 做审批流", capturedAt: "2026-09-30T12:00:00.000Z", markdown: "审批流", status: "ingested" });
  insertSource(env.db, "kb_hitl", "item_hitl_blog", ["常见模式：审批 / 拒绝工具调用"]);
  insertSource(env.db, "kb_checkpoint", "item_hitl_blog", ["checkpointer 保存暂停状态"]);
  const [first, second] = recordedTurns("conversation-thread");
  insertItem(env.db, {
    id: "item_B",
    type: "conversation",
    title: "checkpoint 和 interrupt",
    capturedAt: T(0),
    question: first!.question,
    markdown: first!.answer,
    conversationId: "conv"
  });
  insertItem(env.db, {
    id: "item_B2",
    type: "conversation",
    title: "interrupt 恢复",
    capturedAt: T(3),
    question: second!.question,
    markdown: second!.answer,
    conversationId: "conv"
  });
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(10), markdown: recordedContent("supplement") });
}

function rules() {
  return [
    replay.judge(
      output("learning_judge", "learning", {
        candidate_item_ids: ["item_B", "item_B2", "item_C"],
        item_engagement: [
          { item_id: "item_B", engagement: "strong" },
          { item_id: "item_C", engagement: "strong" }
        ]
      })
    ),
    ...steps("item_B", output("knowledge_processing", "conversation-thread")),
    ...steps("item_C", output("knowledge_processing", "supplement")),
    replay.rewrite("kb_hitl", output("entry_rewrite", "manual-patched")),
    replay.rewrite("kb_checkpoint", output("entry_rewrite", "stale"))
  ];
}

function workerFor(env: TestEnv, gateway: ReturnType<typeof createReplayGateway>["gateway"] | null, now = () => NOW): OrganizeWorker {
  return new OrganizeWorker({ db: env.db, getGateway: () => gateway, getSearchIndex: () => env.searchIndex, now });
}

function enableAuto(env: TestEnv, patch: Partial<OrganizeSettings["triggers"]> = {}): void {
  writeOrganizeSettings(env.db, {
    autoEnabled: true,
    triggers: { daily: { enabled: true, time: "23:00" }, batch: { enabled: true, count: 10 }, onIngest: { enabled: false }, ...patch },
    outputLanguage: "zh"
  });
}

test("worker end-to-end: run → entries + organize_runs; deleting a source → stale → rewritten next run", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seed(env);
  const { gateway } = createReplayGateway(rules());
  const worker = workerFor(env, gateway);
  const events: OrganizeEvent[] = [];
  worker.subscribe((event) => events.push(event));

  const started = worker.enqueueManual({
    trigger: "manual",
    scope: "inbox_pending",
    itemIds: [],
    entryIds: [],
    requirement: "多写对比",
    allowOverLimit: false
  });
  assert.ok("run" in started);
  const busy = worker.enqueueManual({ trigger: "manual", scope: "inbox_pending", itemIds: [], entryIds: [], requirement: null, allowOverLimit: false });
  assert.deepEqual(busy, { conflict: started.run.id });
  await worker.whenIdle();

  const row = getRunRow(env.db, started.run.id)!;
  assert.equal(row.status, "completed");
  assert.ok(row.started_at && row.finished_at);
  assert.equal(row.model, "replay");
  assert.ok(Number(row.tokens) > 0);
  assert.equal(row.progress, null);
  const detail = organizeRunDetailSchema.parse(runDetail(env.db, started.run.id));
  assert.equal(detail.stats.items.ingested, 3);
  assert.equal(detail.items.length, 3);
  assert.ok(detail.items.every((item) => item.status === "ingested" && item.decision === "supplement"));
  assert.ok(detail.entries.some((change) => change.entryId === "kb_hitl" && change.change === "supplemented"));
  const types = events.map((event) => event.type);
  assert.equal(types[0], "run_started");
  assert.ok(types.includes("run_progress"));
  assert.equal(types.filter((type) => type === "item_done").length, 3);
  assert.equal(types.at(-1), "run_finished");
  const requirement = env.db.prepare("SELECT scope, used_at FROM notes WHERE origin = 'organize_requirement'").get() as {
    scope: string;
    used_at: string | null;
  };
  assert.equal(requirement.scope, "fuzzy");
  assert.ok(requirement.used_at);

  env.db.prepare("UPDATE items SET deleted_at = ? WHERE id = 'item_C'").run(new Date(NOW.getTime() + 60_000).toISOString());
  const next = worker.enqueueManual({ trigger: "manual", scope: "kb_pending", itemIds: [], entryIds: [], requirement: null, allowOverLimit: false });
  assert.ok("run" in next);
  await worker.whenIdle();

  const hitl = entry(env.db, "kb_hitl")!;
  assert.equal(hitl.stale, 0);
  assert.ok(String(hitl.body_markdown).includes("## 常见场景"));
  const rewritten = runDetail(env.db, next.run.id)!;
  assert.equal(rewritten.status, "completed");
  assert.ok(rewritten.entries.some((change) => change.entryId === "kb_hitl" && change.change === "rewritten"));
  assert.ok(rewritten.stats.kb.entriesRewritten >= 1);
});

test("worker without AI gateway marks the run failed and emits run_failed", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seed(env);
  const worker = workerFor(env, null);
  const events: OrganizeEvent[] = [];
  worker.subscribe((event) => events.push(event));
  const started = worker.enqueueManual({ trigger: "manual", scope: null, itemIds: [], entryIds: [], requirement: null, allowOverLimit: false });
  assert.ok("run" in started);
  await worker.whenIdle();
  assert.equal(getRunRow(env.db, started.run.id)!.status, "failed");
  const failed = events.find((event) => event.type === "run_failed");
  assert.ok(failed && failed.type === "run_failed" && failed.error.includes("ai_gateway_unavailable"));
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending");
});

test("auto triggers: batch threshold, merging into a queued auto run, catch-up once, next-day resume of paused runs", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seed(env);
  const worker = workerFor(env, null);

  writeOrganizeSettings(env.db, {
    autoEnabled: false,
    triggers: { daily: { enabled: true, time: "23:00" }, batch: { enabled: true, count: 1 }, onIngest: { enabled: true } },
    outputLanguage: "zh"
  });
  assert.equal(worker.enqueueAuto("daily"), null, "auto disabled → no run");
  worker.checkTriggers();
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM organize_runs").get() as { n: number }).n, 0);
  enableAuto(env, { batch: { enabled: true, count: 3 }, daily: { enabled: false, time: "23:00" } });
  assert.ok(worker.nextDailyRunAt() === null);

  const queued = createRun(env.db, { trigger: "daily", scope: null, itemIds: [], entryIds: [], requirement: null, allowOverLimit: false });
  const merged = worker.enqueueAuto("batch");
  assert.equal(merged?.merged, true);
  assert.equal(merged?.run.id, queued.id);
  updateRun(env.db, queued.id, { status: "completed", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:01:00.000Z" });

  worker.checkTriggers();
  const batch = env.db.prepare("SELECT id, trigger FROM organize_runs WHERE trigger = 'batch'").get() as { id: string; trigger: string } | undefined;
  assert.ok(batch, "3 pending items captured after the last auto run → batch run");
  await worker.whenIdle();
  worker.checkTriggers();
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM organize_runs WHERE trigger = 'batch'").get() as { n: number }).n, 1);

  enableAuto(env, { daily: { enabled: true, time: "23:00" } });
  assert.ok(worker.nextDailyRunAt());
  env.db.prepare("UPDATE items SET organize_status = 'pending' WHERE id = 'item_C'").run();
  env.db.prepare("UPDATE organize_runs SET started_at = '2026-09-01T00:00:00.000Z'").run();
  worker.catchUp();
  await worker.whenIdle();
  worker.catchUp();
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM organize_runs WHERE trigger = 'catch_up'").get() as { n: number }).n, 1);

  const paused = createRun(env.db, {
    trigger: "manual",
    scope: "inbox_selected",
    itemIds: ["item_B", "item_C"],
    entryIds: [],
    requirement: null,
    allowOverLimit: false
  });
  setJob(env.db, paused.id, "item", "item_B", "ingested");
  setJob(env.db, paused.id, "item", "item_C", "pending");
  updateRun(env.db, paused.id, { status: "paused", startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:05:00.000Z" });
  worker.resumePausedRuns();
  worker.resumePausedRuns();
  const resumed = env.db.prepare("SELECT scope, scope_ids FROM organize_runs WHERE trigger = 'catch_up' AND scope = 'inbox_selected'").all() as Array<{
    scope_ids: string;
  }>;
  assert.equal(resumed.length, 1);
  assert.deepEqual((JSON.parse(resumed[0]!.scope_ids) as { itemIds: string[] }).itemIds, ["item_C"]);
  await worker.whenIdle();
});

test("start/stop: interrupted runs are requeued and stop() waits for the loop", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seed(env);
  const interrupted = createRun(env.db, {
    trigger: "manual",
    scope: "inbox_selected",
    itemIds: ["item_C"],
    entryIds: [],
    requirement: null,
    allowOverLimit: false
  });
  updateRun(env.db, interrupted.id, { status: "running", startedAt: T(0) });
  const { gateway } = createReplayGateway(rules());
  const worker = workerFor(env, gateway);
  worker.start();
  assert.ok(worker.isStarted());
  await worker.whenIdle();
  await worker.stop();
  assert.equal(getRunRow(env.db, interrupted.id)!.status, "completed");
  assert.equal(worker.isStarted(), false);
});

test("organize routes: settings, preview, run (409 while busy), runs, detail, retry, SSE heartbeat", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seed(env);
  const { gateway } = createReplayGateway(rules());
  const port = 43118;
  const services = {
    appDb: env.app,
    auth: createAuthState("tok", port),
    presence: new PresenceStore(),
    ingestCtx: { app: env.app },
    getPort: () => port,
    workbenchDist: join(tmpdir(), "missing-dist"),
    aiGateway: gateway,
    searchIndex: env.searchIndex
  };
  const app = createApp(services);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}`, authorization: "Bearer tok", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  const settings = organizeSettingsResponseSchema.parse(await (await call("GET", ORGANIZE_API.settings)).json());
  assert.equal(settings.pendingCount, 3);
  assert.equal(settings.activeRunId, null);
  const updated = organizeSettingsResponseSchema.parse(
    await (await call("PUT", ORGANIZE_API.settings, { autoEnabled: true, triggers: { daily: { time: "21:30" } } })).json()
  );
  assert.equal(updated.settings.triggers.daily.time, "21:30");
  assert.equal(updated.settings.triggers.batch.count, settings.settings.triggers.batch.count);
  assert.ok(updated.nextRunAt);
  assert.equal((await call("PUT", ORGANIZE_API.settings, { triggers: { daily: { time: "25:99" } } })).status, 400);

  const preview = (await (await call("POST", ORGANIZE_API.preview, { scope: "inbox_pending" })).json()) as {
    itemCount: number;
    newItemCount: number;
    overDailyLimit: boolean;
  };
  assert.equal(preview.itemCount, 3);
  assert.equal(preview.newItemCount, 3);
  assert.equal(preview.overDailyLimit, false);
  assert.equal((await call("POST", ORGANIZE_API.run, { scope: "item", itemIds: [] })).status, 400);

  const started = await call("POST", ORGANIZE_API.run, { scope: "inbox_pending" });
  assert.equal(started.status, 202);
  const { run } = (await started.json()) as { run: { id: string } };
  const conflict = await call("POST", ORGANIZE_API.run, { scope: "inbox_pending" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "run_in_progress", runId: run.id });
  await organizeWorkerFor(services).whenIdle();

  const runs = organizeRunsResponseSchema.parse(await (await call("GET", `${ORGANIZE_API.runs}?limit=10`)).json());
  assert.equal(runs.runs[0]!.id, run.id);
  assert.equal(runs.runs[0]!.status, "completed");
  const detail = organizeRunDetailSchema.parse(await (await call("GET", ORGANIZE_API.runDetail(run.id))).json());
  assert.equal(detail.items.length, 3);
  assert.equal((await call("GET", ORGANIZE_API.runDetail("missing"))).status, 404);
  assert.equal((await call("POST", ORGANIZE_API.retry(run.id))).status, 422);
  assert.equal((await call("POST", ORGANIZE_API.retry("missing"))).status, 404);

  const controller = new AbortController();
  const sse = await app.request(`http://127.0.0.1:${port}${ORGANIZE_API.events}`, {
    headers: { host: `127.0.0.1:${port}`, authorization: "Bearer tok" },
    signal: controller.signal
  });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = sse.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: heartbeat/);
  await reader.cancel();
  controller.abort();
});
