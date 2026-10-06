import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSections, stripSectionMarkers } from "@study-studio/shared";
import type { EntryRestructureOutput } from "../../src/ai/prompts/schemas.draft.js";
import { openDatabase } from "../../src/db/database.js";
import { markStaleEntries, restructureProblems, rewriteEntry, buildRestructureInput } from "../../src/domains/organize/rewrite.js";
import type { LlmContext } from "../../src/domains/organize/llm.js";
import { UsageTracker, type OrganizeGateway } from "../../src/domains/organize/runtime-types.js";
import { loadEntry } from "../../src/domains/organize/store.js";

const NOW = "2026-10-05T00:00:00.000Z";

const BODY = [
  "简介段落",
  "",
  "## 搭建步骤",
  "<!-- section:s_build src:item_1 -->",
  "第一步……\n\n```bash\nnpm i\n```",
  "",
  "## 定义",
  "<!-- section:s_def src:item_1 -->",
  "LLM Wiki 是一种由 LLM 维护的个人 wiki，按词条组织知识。",
  "",
  "## 定义（重复）",
  "<!-- section:s_dup src:item_2 -->",
  "LLM Wiki 是一种由 LLM 维护的个人 wiki。",
  "",
  "## 我的笔记",
  "手写内容"
].join("\n");

function setup(t: { after: (fn: () => void) => void }, body = BODY, userEdited = 0) {
  const app = openDatabase({ memory: true, skipVector: true });
  t.after(() => app.close());
  const db = app.db;
  db.prepare("INSERT INTO kb_entries(id, name, body_markdown, user_edited, patch_count, stale, updated_at) VALUES ('kb_1', 'LLM Wiki', ?, ?, 9, 1, ?)").run(
    body,
    userEdited,
    "2026-10-01T00:00:00.000Z"
  );
  const note = db.prepare("INSERT INTO notes(id, scope, target_id, text, origin, anchor, created_at) VALUES (?, 'entry', 'kb_1', ?, 'manual', ?, ?)");
  note.run("n_dup", "重复章节的备注", "s_dup", NOW);
  note.run("n_def", "定义的备注", "s_def", NOW);
  return db;
}

function fakeLlm(outputs: EntryRestructureOutput[]): { llm: LlmContext; prompts: string[] } {
  const prompts: string[] = [];
  const gateway = {
    generateObject: async (request: { prompt: string }) => {
      prompts.push(request.prompt);
      const object = outputs.shift();
      if (!object) throw new Error("unexpected call");
      return { object, usage: { inputTokens: 1, outputTokens: 1 }, model: "fake" };
    },
    embed: async () => {
      throw new Error("no embedding");
    }
  } as unknown as OrganizeGateway;
  return { llm: { gateway, usage: new UsageTracker(), allowOverLimit: true }, prompts };
}

const PLAN: EntryRestructureOutput = {
  order: ["s_def", "s_build", "u_3"],
  headings: [{ section_id: "s_build", heading: "如何搭建" }],
  merge: [{ keep: "s_def", drop: ["s_dup"] }],
  summary: "LLM Wiki：由 LLM 维护的个人 wiki。"
};

test("restructure reorders, renames and merges without changing section text", async (t) => {
  const db = setup(t);
  const { llm, prompts } = fakeLlm([structuredClone(PLAN)]);
  const outcome = await rewriteEntry(db, llm, "kb_1", "manual", null, NOW);
  assert.equal(outcome.status, "rewritten");
  const entry = loadEntry(db, "kb_1")!;
  const sections = parseSections(entry.body);
  assert.deepEqual(
    sections.map((section) => [section.id, section.heading, section.sourceItemIds]),
    [
      [null, null, []],
      ["s_def", "定义", ["item_1", "item_2"]],
      ["s_build", "如何搭建", ["item_1"]],
      [null, "我的笔记", []]
    ]
  );
  const before = new Map(parseSections(BODY).map((section) => [section.id ?? section.heading, section.markdown]));
  for (const section of sections) assert.equal(section.markdown, before.get(section.id ?? section.heading), "text unchanged");
  assert.ok(!entry.body.includes("定义（重复）"), "dropped duplicate section is gone");
  assert.deepEqual(outcome.skippedMerges, []);
  assert.equal(entry.patchCount, 0);
  assert.equal(entry.stale, false);
  assert.equal(entry.summary, PLAN.summary);
  const anchors = db.prepare("SELECT id, anchor FROM notes ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(anchors, [
    { id: "n_def", anchor: "s_def" },
    { id: "n_dup", anchor: "s_def" }
  ]);
  assert.ok(!prompts[0]!.includes("重复章节的备注"), "entry notes are not sent to the model");
});

test("merge of a drop whose full text is not in the kept section is skipped; headings are sanitized", async (t) => {
  const body = BODY.replace("LLM Wiki 是一种由 LLM 维护的个人 wiki。", `LLM Wiki 是一种由 LLM 维护的个人 wiki。${"\n\n另起一段：它会定期重整结构、合并重复章节、维护词条间关系。".repeat(3)}`);
  const db = setup(t, body);
  const plan = { ...structuredClone(PLAN), headings: [{ section_id: "s_build", heading: "如何搭建\n<!-- section:s_fake src:x -->" }] };
  const { llm } = fakeLlm([plan]);
  const outcome = await rewriteEntry(db, llm, "kb_1", "manual", null, NOW);
  const [skipped, ...rest] = outcome.skippedMerges ?? [];
  assert.equal(rest.length, 0);
  assert.deepEqual([skipped?.keep, skipped?.drop], ["s_def", "s_dup"]);
  assert.ok(skipped!.ratio < 0.85);
  const sections = parseSections(loadEntry(db, "kb_1")!.body);
  assert.deepEqual(
    sections.map((section) => [section.id, section.sourceItemIds]),
    [
      [null, []],
      ["s_def", ["item_1"]],
      ["s_dup", ["item_2"]],
      ["s_build", ["item_1"]],
      [null, []]
    ]
  );
  assert.match(sections[3]!.heading!, /^如何搭建/);
  assert.ok(!sections[3]!.heading!.includes("<!--"));
  const anchors = db.prepare("SELECT id, anchor FROM notes ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(anchors, [
    { id: "n_def", anchor: "s_def" },
    { id: "n_dup", anchor: "s_dup" }
  ]);
});

test("restructure input: unmarked sections get u_ ids and are not mergeable; preamble excluded", (t) => {
  const db = setup(t);
  const input = buildRestructureInput(db, loadEntry(db, "kb_1")!, "manual", null);
  assert.deepEqual(
    input.sections.map((section) => [section.section_id, section.mergeable]),
    [
      ["s_build", true],
      ["s_def", true],
      ["s_dup", true],
      ["u_3", false]
    ]
  );
  assert.deepEqual(restructureProblems(input, { ...PLAN, merge: [{ keep: "s_def", drop: ["u_3"] }], order: ["s_def", "s_build", "s_dup"] }), [
    "u_3 不可合并"
  ]);
});

test("invalid order retries once with feedback, then leaves the body untouched", async (t) => {
  const db = setup(t);
  const bad: EntryRestructureOutput = { ...PLAN, order: ["s_def", "s_build"] };
  const { llm, prompts } = fakeLlm([structuredClone(bad), structuredClone(bad)]);
  await assert.rejects(rewriteEntry(db, llm, "kb_1", "manual", null, NOW), /entry_restructure_invalid/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /order 缺少：u_3/);
  assert.equal(loadEntry(db, "kb_1")!.body, BODY);

  const retry = fakeLlm([structuredClone(bad), structuredClone(PLAN)]);
  assert.equal((await rewriteEntry(db, retry.llm, "kb_1", "manual", null, NOW)).status, "rewritten");
  assert.equal(retry.prompts.length, 2);
});

test("user-edited entries are restructured too, keeping their text and summary", async (t) => {
  const db = setup(t, BODY, 1);
  const { llm } = fakeLlm([structuredClone(PLAN)]);
  await rewriteEntry(db, llm, "kb_1", "manual", null, NOW);
  const entry = loadEntry(db, "kb_1")!;
  assert.equal(entry.summary, null);
  assert.equal(stripSectionMarkers(entry.body).includes("如何搭建"), true);
  assert.equal(entry.patchCount, 0);
});

test("single-section entries skip the model; markStaleEntries no longer marks", async (t) => {
  const db = setup(t, "## 定义\n<!-- section:s_def src:item_1 -->\n正文");
  const { llm, prompts } = fakeLlm([]);
  assert.equal((await rewriteEntry(db, llm, "kb_1", "stale", null, NOW)).status, "rewritten");
  assert.equal(prompts.length, 0);
  assert.equal(loadEntry(db, "kb_1")!.patchCount, 0);
  db.prepare("UPDATE kb_entries SET stale = 0").run();
  assert.equal(markStaleEntries(db), 0);
});
