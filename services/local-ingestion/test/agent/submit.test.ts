import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSections } from "@study-studio/shared";
import { AgentToolError } from "../../src/domains/agent/errors";
import { AGENT_IDLE_MS, expireIdleAgentRuns, startAgentSession } from "../../src/domains/agent/session";
import {
  addRelation,
  addRelationSchema,
  attachSource,
  attachSourceSchema,
  finishUnit,
  finishUnitSchema,
  writeEntry,
  writeEntrySchema
} from "../../src/domains/agent/submit";
import { getRunRow, runJobs, toRunSummary } from "../../src/domains/organize/run-store";
import { createEnv, entry, insertEntry, insertItem, insertNote, itemStatus, NOW, result, type TestEnv } from "../organize/helpers";

const HITL_BODY = "## 定义\n<!-- section:s_hitl0001 src:item_old -->\n在 Agent 执行过程中插入人工审批节点。";
const CONTENT = "# Human-in-the-loop\n\nThe interrupt() function pauses graph execution.\n\nCommand(resume=value) resumes the paused run.";

function setup(t: { after: (fn: () => void) => void }): { env: TestEnv; runId: string } {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", aliases: ["HITL"], body: HITL_BODY, category: "Agent 框架", patchCount: 2 });
  insertEntry(env.db, { id: "kb_checkpoint", name: "Checkpoint", body: "## 定义\n图状态快照。" });
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: "2026-10-02T12:00:00.000Z", markdown: CONTENT });
  const started = startAgentSession(env.db, "cursor");
  assert.ok(started.ok);
  return { env, runId: started.runId };
}

const deps = (env: TestEnv) => ({ db: env.db, indexCtx: null, now: () => NOW });
const write = (env: TestEnv, input: unknown) => writeEntry(deps(env), writeEntrySchema.parse(input));
const attach = (env: TestEnv, input: unknown) => attachSource(deps(env), attachSourceSchema.parse(input));
const relate = (env: TestEnv, input: unknown) => addRelation(deps(env), addRelationSchema.parse(input));
const finish = (env: TestEnv, input: unknown) => finishUnit(deps(env), finishUnitSchema.parse(input));

const toolError = (code: string) => (error: unknown) => error instanceof AgentToolError && error.code === code;

const sources = (env: TestEnv, entryId: string) =>
  env.db.prepare("SELECT item_id, evidence FROM kb_entry_sources WHERE entry_id = ? ORDER BY item_id").all(entryId) as Array<{ item_id: string; evidence: string }>;

test("write_entry new + supplement, finish organized → decision new with stats", async (t) => {
  const { env, runId } = setup(t);
  const created = await write(env, {
    run_id: runId,
    unit_key: "item_C",
    new: { name: "Command", aliases: ["Command 指令"], kind: "概念", category: "Agent 框架", summary: "LangGraph 恢复执行的指令" },
    sections: [{ heading: "定义", markdown: "Command(resume=value) 恢复被 interrupt 暂停的运行。\n\n## 用法\n传入 resume 值。", source_item_ids: ["item_C"] }]
  });
  assert.equal(created.created, true);
  const newId = created.entry_id as string;
  const [section] = parseSections(String(entry(env.db, newId)!.body_markdown));
  assert.equal(section!.heading, "定义");
  assert.deepEqual(section!.sourceItemIds, ["item_C"]);
  assert.match(section!.markdown, /^### 用法$/m, "fragment headings demoted below ##");
  assert.equal(section!.id, (created.sections as Array<{ section_id: string }>)[0]!.section_id);
  assert.equal(entry(env.db, newId)!.kind, "概念");

  const supplemented = await write(env, {
    run_id: runId,
    unit_key: "item_C",
    entry_id: "kb_hitl",
    sections: [{ heading: "实现方式", markdown: "The interrupt() function pauses graph execution.", source_item_ids: ["item_C"] }]
  });
  const hitl = entry(env.db, "kb_hitl")!;
  assert.equal(hitl.patch_count, 3);
  const hitlSections = parseSections(String(hitl.body_markdown));
  assert.deepEqual(
    hitlSections.map((s) => s.heading),
    ["定义", "实现方式"]
  );
  assert.equal(hitlSections[0]!.markdown, "在 Agent 执行过程中插入人工审批节点。", "existing section untouched");
  const sectionId = (supplemented.sections as Array<{ section_id: string }>)[0]!.section_id;
  assert.deepEqual(
    sources(env, "kb_hitl").map((row) => [row.item_id, JSON.parse(row.evidence)]),
    [["item_C", [{ section_id: sectionId, heading: "实现方式", quote: "实现方式" }]]]
  );
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending", "status changes only on finish_unit");

  const relation = relate(env, { run_id: runId, unit_key: "item_C", from: "Command", to: "kb_hitl", type: "part_of", description: "HITL 的恢复机制" });
  assert.equal(relation.created, true);

  const out = finish(env, { run_id: runId, unit_key: "item_C", status: "organized", reason: "新增 Command、补充 HITL" });
  assert.equal(out.decision, "new");
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  const row = result(env.db, "item_C")!;
  assert.equal(row.route, "agent");
  assert.equal(row.decision, "new");
  assert.equal(row.model, "agent:cursor");
  assert.equal(row.run_id, runId);
  assert.deepEqual(JSON.parse(String(row.target_entry_ids)).sort(), [newId, "kb_hitl"].sort());
  assert.deepEqual(
    runJobs(env.db, runId).map((job) => [job.target_id, job.status]),
    [["item_C", "ingested"]]
  );
  const stats = toRunSummary(getRunRow(env.db, runId)!).stats;
  assert.equal(stats.items.ingested, 1);
  assert.equal(stats.decisions.new, 1);
  assert.equal(stats.kb.entriesCreated, 1);
  assert.equal(stats.kb.entriesSupplemented, 1);
  assert.equal(stats.kb.relationsCreated, 1);
  const traces = env.db.prepare("SELECT step FROM organize_traces WHERE run_id = ?").all(runId) as Array<{ step: string }>;
  assert.ok(traces.length >= 4 && traces.every((trace) => trace.step === "agent_submit"));

  await assert.rejects(write(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", sections: [{ heading: "x", markdown: "y", source_item_ids: ["item_C"] }] }), toolError("already_organized"));
});

test("write_entry supplement only → finish organized decision supplement", async (t) => {
  const { env, runId } = setup(t);
  await write(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", sections: [{ heading: "恢复", markdown: "Command(resume=value) resumes the paused run.", source_item_ids: ["item_C"] }] });
  assert.equal(finish(env, { run_id: runId, unit_key: "item_C", status: "organized", reason: "补充" }).decision, "supplement");
  assert.equal(toRunSummary(getRunRow(env.db, runId)!).stats.decisions.supplement, 1);
});

test("write_entry new with existing name / alias → name_exists + entry_id, no writes", async (t) => {
  const { env, runId } = setup(t);
  for (const spec of [{ name: "hitl" }, { name: "人在回路", aliases: ["Human-in-the-loop"] }]) {
    await assert.rejects(
      write(env, { run_id: runId, unit_key: "item_C", new: { kind: "概念", summary: "s", ...spec }, sections: [{ heading: "定义", markdown: "x", source_item_ids: ["item_C"] }] }),
      (error) => toolError("name_exists")(error) && (error as AgentToolError).details && (((error as AgentToolError).details as { entry_id: string }).entry_id === "kb_hitl")
    );
  }
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM kb_entries").get() as { n: number }).n, 2);
});

test("write_entry validation: entry_id xor new, unit sources, kind, entry alive", async (t) => {
  const { env, runId } = setup(t);
  const section = { heading: "定义", markdown: "x", source_item_ids: ["item_C"] };
  await assert.rejects(write(env, { run_id: runId, unit_key: "item_C", sections: [section] }), toolError("invalid_input"));
  await assert.rejects(
    write(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", sections: [{ ...section, source_item_ids: ["item_other"] }] }),
    toolError("invalid_source")
  );
  await assert.rejects(
    write(env, { run_id: runId, unit_key: "item_C", new: { name: "Command", kind: "胡乱类型", summary: "s" }, sections: [section] }),
    toolError("invalid_kind")
  );
  await assert.rejects(write(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_missing", sections: [section] }), toolError("entry_not_found"));
  await assert.rejects(write(env, { run_id: "run_x", unit_key: "item_C", entry_id: "kb_hitl", sections: [section] }), toolError("run_not_active"));
  assert.equal(entry(env.db, "kb_hitl")!.body_markdown, HITL_BODY);
});

test("attach_source → section src + evidence; finish organized → duplicate", async (t) => {
  const { env, runId } = setup(t);
  assert.throws(() => attach(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", section_id: "s_missing", item_ids: ["item_C"] }), toolError("section_not_found"));
  const out = attach(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", section_id: "s_hitl0001", item_ids: ["item_C"] });
  assert.deepEqual(out.source_item_ids, ["item_old", "item_C"]);
  const body = String(entry(env.db, "kb_hitl")!.body_markdown);
  assert.match(body, /<!-- section:s_hitl0001 src:item_old,item_C -->/);
  assert.equal(entry(env.db, "kb_hitl")!.patch_count, 2);
  assert.deepEqual(JSON.parse(sources(env, "kb_hitl")[0]!.evidence), [{ section_id: "s_hitl0001", heading: "定义", quote: "定义" }]);

  const finished = finish(env, { run_id: runId, unit_key: "item_C", status: "organized", reason: "已覆盖" });
  assert.equal(finished.decision, "duplicate");
  assert.deepEqual(finished.entry_changes, [{ entry_id: "kb_hitl", name: "Human-in-the-loop", change: "duplicate" }]);
  assert.equal(result(env.db, "item_C")!.decision, "duplicate");
});

test("finish organized without writes → nothing_written", async (t) => {
  const { env, runId } = setup(t);
  assert.throws(() => finish(env, { run_id: runId, unit_key: "item_C", status: "organized", reason: "x" }), toolError("nothing_written"));
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending");
});

test("finish after writes only accepts organized → unit_has_writes", async (t) => {
  const { env, runId } = setup(t);
  attach(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", section_id: "s_hitl0001", item_ids: ["item_C"] });
  for (const status of ["rejected", "not_learning", "skipped"]) {
    assert.throws(() => finish(env, { run_id: runId, unit_key: "item_C", status, reason: "x" }), toolError("unit_has_writes"));
  }
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending");
  assert.equal(finish(env, { run_id: runId, unit_key: "item_C", status: "organized", reason: "x" }).decision, "duplicate");
});

test("idle expiry finishes units with writes as organized", async (t) => {
  const { env, runId } = setup(t);
  await write(env, { run_id: runId, unit_key: "item_C", entry_id: "kb_hitl", sections: [{ heading: "恢复", markdown: "Command(resume=value) resumes the paused run.", source_item_ids: ["item_C"] }] });
  assert.equal(expireIdleAgentRuns(env.db, new Date(Date.now() + AGENT_IDLE_MS + 1000)), 1);
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  assert.equal(result(env.db, "item_C")!.decision, "supplement");
  assert.equal(getRunRow(env.db, runId)!.status, "completed");
});

test("write_entry new with an ignored name / alias → name_ignored", async (t) => {
  const { env, runId } = setup(t);
  env.db.prepare("INSERT INTO kb_ignore(name, created_at) VALUES ('Interrupt', ?)").run(NOW.toISOString());
  for (const spec of [{ name: "interrupt" }, { name: "中断", aliases: ["Interrupt"] }]) {
    await assert.rejects(
      write(env, { run_id: runId, unit_key: "item_C", new: { kind: "概念", summary: "s", ...spec }, sections: [{ heading: "定义", markdown: "x", source_item_ids: ["item_C"] }] }),
      toolError("name_ignored")
    );
  }
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM kb_entries").get() as { n: number }).n, 2);
});

test("write_entry schema rejects multi-line / oversized headings and oversized markdown", () => {
  const base = { run_id: "r", unit_key: "u", entry_id: "kb_hitl" };
  const section = { heading: "定义", markdown: "x", source_item_ids: ["item_C"] };
  assert.ok(writeEntrySchema.safeParse({ ...base, sections: [section] }).success);
  for (const bad of [{ heading: "定义\n<!-- section:s_x src:y -->" }, { heading: "长".repeat(121) }, { markdown: "x".repeat(20_001) }]) {
    assert.equal(writeEntrySchema.safeParse({ ...base, sections: [{ ...section, ...bad }] }).success, false);
  }
});

test("finish marks item notes and nearby fuzzy notes used", async (t) => {
  const { env, runId } = setup(t);
  insertNote(env.db, { id: "note_fuzzy", scope: "fuzzy", targetId: null, text: "关注恢复机制", createdAt: "2026-10-02T12:30:00.000Z" });
  finish(env, { run_id: runId, unit_key: "item_C", status: "not_learning", reason: "x" });
  assert.ok((env.db.prepare("SELECT used_at FROM notes WHERE id = 'note_fuzzy'").get() as { used_at: string | null }).used_at);
});

test("finish rejected / not_learning / skipped", async (t) => {
  const { env, runId } = setup(t);
  insertNote(env.db, { id: "note_c", scope: "item", targetId: "item_C", text: "只是导航", createdAt: "2026-10-02T12:01:00.000Z" });
  finish(env, { run_id: runId, unit_key: "item_C", status: "rejected", reason: "导航页", reject_reason: "navigational" });
  assert.equal(itemStatus(env.db, "item_C").organize_status, "rejected");
  const row = result(env.db, "item_C")!;
  assert.equal(row.decision, "reject");
  assert.equal(row.reject_reason, "navigational");
  assert.ok((env.db.prepare("SELECT used_at FROM notes WHERE id = 'note_c'").get() as { used_at: string | null }).used_at);

  insertItem(env.db, { id: "item_D", title: "娱乐", capturedAt: "2026-10-02T13:00:00.000Z", markdown: "八卦" });
  finish(env, { run_id: runId, unit_key: "item_D", status: "not_learning", reason: "娱乐内容" });
  assert.equal(result(env.db, "item_D")!.decision, "not_learning");

  insertItem(env.db, { id: "item_E", title: "稍后", capturedAt: "2026-10-02T14:00:00.000Z", markdown: "稍后再看" });
  assert.deepEqual(finish(env, { run_id: runId, unit_key: "item_E", status: "skipped", reason: "用户跳过" }), { status: "skipped" });
  assert.equal(itemStatus(env.db, "item_E").organize_status, "pending");
  assert.equal(result(env.db, "item_E"), undefined);

  const stats = toRunSummary(getRunRow(env.db, runId)!).stats;
  assert.equal(stats.decisions.reject, 1);
  assert.equal(stats.decisions.notLearning, 1);
  assert.equal(stats.items.rejected, 2);
});
