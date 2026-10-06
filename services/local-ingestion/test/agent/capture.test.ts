import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentTools, runAgentTool } from "../../src/domains/agent/tools";
import { findUnit } from "../../src/domains/agent/units";
import { loadTimeline } from "../../src/domains/organize/context";
import { collectActivities } from "../../src/domains/timeline/activity";
import { localDay } from "../../src/domains/timeline/time";
import { createEnv, NOW } from "../organize/helpers";

const tool = agentTools().find((candidate) => candidate.name === "add_to_inbox")!;

test("add_to_inbox stores conversation turns verbatim as one threaded unit tagged with the agent", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const turns = [
    { question: "什么是 HITL？", answer: "## HITL\n在 Agent 执行中插入人工审批。\n```py\ninterrupt()\n```" },
    { question: "需要 checkpointer 吗？", answer: "需要，状态要持久化。" }
  ];
  const result = await runAgentTool(tool, { db: env.db, indexCtx: null, now: () => NOW }, { agent: "Cursor", source: "conversation", turns });
  assert.ok(result.ok);
  const unit = findUnit(env.db, result.unit_key as string);
  assert.ok(unit);
  assert.deepEqual(
    unit.items.map((item) => ({ type: item.type, site: item.site, question: item.question, body: item.markdown })),
    turns.map((turn) => ({ type: "conversation", site: "Cursor", question: turn.question, body: turn.answer }))
  );
  const turnUnits = loadTimeline(env.db, unit.items).units.filter((u) => u.kind === "ai_turn");
  assert.deepEqual(
    turnUnits.map((u) => u.kind === "ai_turn" && [u.platform, u.question, u.turnIndex, u.id.startsWith("item:")]),
    [
      ["Cursor", "什么是 HITL？", 1, false],
      ["Cursor", "需要 checkpointer 吗？", 2, false]
    ]
  );
});

test("add_to_inbox reads files from disk as documents and rejects bad paths", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const deps = { db: env.db, indexCtx: null, now: () => NOW };
  const file = join(mkdtempSync(join(tmpdir(), "ss-capture-")), "notes.md");
  writeFileSync(file, "# Checkpoint\n图状态快照。\n");
  const result = await runAgentTool(tool, deps, { agent: "Claude Code", source: "file", file_path: file });
  assert.ok(result.ok);
  const item = findUnit(env.db, result.unit_key as string)!.items[0]!;
  assert.equal(item.type, "document");
  assert.equal(item.site, "Claude Code");
  assert.equal(item.title, "notes.md");
  assert.equal(item.markdown, "# Checkpoint\n图状态快照。\n");
  const session = loadTimeline(env.db, [item]).units.find((u) => u.kind === "page_session");
  assert.ok(session?.kind === "page_session" && session.category === "learning_candidate" && session.itemId === item.id && !session.id.startsWith("item:"));
  const day = localDay(NOW);
  const rows = collectActivities(env.db, { from: day, to: day }).filter((row) => row.type === "document");
  assert.deepEqual(rows.map((row) => [row.title, row.itemId]), [["Claude Code · notes.md", item.id]]);

  const relative = await runAgentTool(tool, deps, { agent: "Codex", source: "file", file_path: "notes.md" });
  assert.equal(relative.ok, false);
  const missing = await runAgentTool(tool, deps, { agent: "Codex", source: "conversation" });
  assert.equal(missing.ok, false);
});
