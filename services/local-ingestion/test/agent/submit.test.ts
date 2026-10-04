import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentToolError } from "../../src/domains/agent/errors";
import { startAgentSession } from "../../src/domains/agent/session";
import { submitDecision, submitDecisionSchema, type SubmitDecisionInput } from "../../src/domains/agent/submit";
import { findUnit } from "../../src/domains/agent/units";
import { getRunRow, runJobs, toRunSummary } from "../../src/domains/organize/run-store";
import { createEnv, entry, insertEntry, insertItem, insertSelection, itemStatus, NOW, result, type TestEnv } from "../organize/helpers";

const HITL_BODY = "## 定义\n在 Agent 执行过程中插入人工审批节点。\n## 实现方式\nLangGraph 中用 interrupt() 暂停。";
const CONTENT = [
  "# Human-in-the-loop",
  "The interrupt() function pauses graph execution at a specific node and surfaces a value to the client.",
  "",
  "HITL requires a checkpointer:   graph state is persisted at each step.",
  "",
  "Command(resume=value) resumes the paused run."
].join("\n");

function setup(t: { after: (fn: () => void) => void }): { env: TestEnv; runId: string } {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", aliases: ["HITL"], body: HITL_BODY, category: "Agent 框架" });
  insertEntry(env.db, { id: "kb_checkpoint", name: "Checkpoint", body: "## 定义\n图状态快照。", category: "Agent 框架" });
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: "2026-10-02T12:00:00.000Z", markdown: CONTENT });
  const started = startAgentSession(env.db, "cursor");
  assert.ok(started.ok);
  return { env, runId: started.runId };
}

const submit = (env: TestEnv, input: unknown) =>
  submitDecision({ db: env.db, indexCtx: null, now: () => NOW }, submitDecisionSchema.parse(input) as SubmitDecisionInput, "cursor");

const point = (quote: string, concept: string, importance: "core" | "supporting" | "detail" = "core") => ({
  statement: quote,
  quote,
  section: null,
  concept,
  importance,
  turn_item_id: null
});

function composeInput(runId: string, patch: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    unit_key: "item_C",
    decision: "compose",
    value_score: 0.8,
    reason: "补充 interrupt 细节并新增 Command 词条",
    thesis: "LangGraph HITL",
    points: [
      point("The interrupt() function pauses graph execution at a specific node", "Human-in-the-loop"),
      point("HITL requires a checkpointer: graph state is persisted at each step.", "Human-in-the-loop"),
      point("Command(resume=value) resumes the paused run.", "Command")
    ],
    compose: {
      item_summary: "LangGraph HITL 文档",
      item_points: ["interrupt 暂停", "需要 checkpointer"],
      concepts: [
        {
          name: "Human-in-the-loop",
          match: "kb_hitl",
          aliases: [],
          kind: "concept",
          point_ids: ["p1", "p2"],
          patch: { ops: [{ op: "append_to_section", section: "## 实现方式", markdown: "需要 checkpointer 持久化状态。" }], summary: null, completeness: null },
          category: null,
          summary: null,
          body_markdown: null,
          completeness: null
        },
        {
          name: "Command",
          match: "new",
          aliases: [],
          kind: "concept",
          point_ids: ["p3"],
          patch: null,
          category: "Agent 框架",
          summary: "LangGraph 恢复执行的指令",
          body_markdown: "## 定义\nCommand(resume=value) 恢复被 interrupt 暂停的运行。",
          completeness: null
        }
      ],
      relations: [],
      dropped: []
    },
    ...patch
  };
}

function assertNoWrites(env: TestEnv): void {
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending");
  assert.equal(result(env.db, "item_C"), undefined);
  assert.equal(entry(env.db, "kb_hitl")!.body_markdown, HITL_BODY);
}

const toolError = (code: string) => (error: unknown) => error instanceof AgentToolError && error.code === code;

test("compose: supplement + new entry, items ingested, route agent, run stats", async (t) => {
  const { env, runId } = setup(t);
  const out = await submit(env, composeInput(runId));

  assert.equal(out.ok, true);
  const changes = new Map(out.entry_changes.map((change) => [change.name, change]));
  assert.equal(changes.get("Human-in-the-loop")?.change, "supplemented");
  assert.equal(changes.get("Command")?.change, "created");
  assert.ok(String(entry(env.db, "kb_hitl")!.body_markdown).includes("需要 checkpointer 持久化状态。"));
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  const row = result(env.db, "item_C")!;
  assert.equal(row.route, "agent");
  assert.equal(row.decision, "new");
  assert.equal(row.model, "agent:cursor");
  assert.equal(row.run_id, runId);
  assert.deepEqual(
    runJobs(env.db, runId).map((job) => [job.target_id, job.status]),
    [["item_C", "ingested"]]
  );
  const stats = toRunSummary(getRunRow(env.db, runId)!).stats;
  assert.equal(stats.items.ingested, 1);
  assert.equal(stats.decisions.new, 1);
  assert.equal(stats.kb.entriesCreated, 1);
  assert.equal(stats.kb.entriesSupplemented, 1);

  await assert.rejects(submit(env, composeInput(runId)), toolError("already_organized"));
});

test("compose: quote not in unit text → quote_not_found, no writes", async (t) => {
  const { env, runId } = setup(t);
  const input = composeInput(runId);
  input.points[1] = point("HITL never needs a checkpointer.", "Human-in-the-loop");
  await assert.rejects(submit(env, input), (error) => toolError("quote_not_found")(error) && JSON.stringify((error as AgentToolError).details) === "[1]");
  assertNoWrites(env);
});

test("compose: validateCompose problems → invalid_compose, no writes", async (t) => {
  const { env, runId } = setup(t);
  const input = composeInput(runId);
  input.compose.concepts[0]!.match = "kb_missing";
  await assert.rejects(submit(env, input), toolError("invalid_compose"));
  assertNoWrites(env);
});

test("compose: unassigned core point → missing_points feedback", async (t) => {
  const { env, runId } = setup(t);
  const input = composeInput(runId);
  input.compose.concepts[0]!.point_ids = ["p1"];
  await assert.rejects(submit(env, input), (error) => toolError("missing_points")(error) && (error as Error).message.includes("p2"));
  assertNoWrites(env);
});

test("duplicate (unmarked) → sources attached, item ingested", async (t) => {
  const { env, runId } = setup(t);
  const out = await submit(env, {
    run_id: runId,
    unit_key: "item_C",
    decision: "duplicate",
    reason: "已覆盖",
    target_entry_ids: ["kb_hitl"],
    evidence: [{ entry_id: "kb_hitl", quote: "pauses graph execution at a specific node" }]
  });
  assert.deepEqual(out.entry_changes, [{ entry_id: "kb_hitl", name: "Human-in-the-loop", change: "duplicate" }]);
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  assert.equal(result(env.db, "item_C")!.decision, "duplicate");
  assert.equal(toRunSummary(getRunRow(env.db, runId)!).stats.decisions.duplicate, 1);
});

test("duplicate on highlighted unit → marked_requires_compose", async (t) => {
  const { env, runId } = setup(t);
  insertSelection(env.db, "item_C", "Command(resume=value)", "2026-10-02T12:01:00.000Z");
  assert.equal(findUnit(env.db, "item_C")!.items[0]!.highlights.length, 1);
  await assert.rejects(
    submit(env, { run_id: runId, unit_key: "item_C", decision: "duplicate", reason: "已覆盖", target_entry_ids: ["kb_hitl"] }),
    toolError("marked_requires_compose")
  );
  assertNoWrites(env);
});

test("reject → rejected with reason", async (t) => {
  const { env, runId } = setup(t);
  await submit(env, { run_id: runId, unit_key: "item_C", decision: "reject", reason: "导航页", reject_reason: "navigational" });
  assert.equal(itemStatus(env.db, "item_C").organize_status, "rejected");
  const row = result(env.db, "item_C")!;
  assert.equal(row.decision, "reject");
  assert.equal(row.reject_reason, "navigational");
  assert.equal(row.route, "agent");
});

test("not_learning → rejected with decision not_learning", async (t) => {
  const { env, runId } = setup(t);
  await submit(env, { run_id: runId, unit_key: "item_C", decision: "not_learning", reason: "娱乐内容" });
  assert.equal(itemStatus(env.db, "item_C").organize_status, "rejected");
  assert.equal(result(env.db, "item_C")!.decision, "not_learning");
  const stats = toRunSummary(getRunRow(env.db, runId)!).stats;
  assert.equal(stats.decisions.notLearning, 1);
  assert.equal(stats.items.rejected, 1);
});
