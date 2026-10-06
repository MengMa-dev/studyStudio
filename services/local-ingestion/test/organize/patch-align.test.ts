import assert from "node:assert/strict";
import { test } from "node:test";
import { SUGGESTION_HEADING, applyPatchOps, decideAlignment, demoteNewBodyToSupplement, normalizeEntryName } from "../../src/domains/organize/index.js";

const BODY = `# Checkpoint

## 定义

图执行中的持久化快照。

## 实现方式

MemorySaver 用于测试。
`;

test("normalizeEntryName collapses case and full-width parens", () => {
  assert.equal(normalizeEntryName("Human-in-the-loop（HITL）"), normalizeEntryName("human-in-the-loop(hitl)"));
});

test("⑥ alignment: match id, normalized name, embedding>0.92, kb_ignore", () => {
  const entries = [
    { id: "kb_hitl", name: "Human-in-the-loop", aliases: ["HITL"], kind: "concept" },
    { id: "kb_cp", name: "Checkpoint", aliases: [], kind: "concept" }
  ];

  assert.equal(
    decideAlignment({
      match: "kb_hitl",
      name: "HITL",
      existing_entries: entries,
      kb_ignore_names: []
    }).action,
    "use_existing"
  );

  const byName = decideAlignment({
    match: "new",
    name: "human-in-the-loop",
    body_markdown: "新正文",
    existing_entries: entries,
    kb_ignore_names: []
  });
  assert.equal(byName.action, "use_existing");
  if (byName.action === "use_existing") {
    assert.equal(byName.via, "normalized_name");
    assert.equal(byName.demote_body_to_supplement, true);
  }

  const byEmbed = decideAlignment({
    match: "new",
    name: "人工介入",
    kind: "concept",
    body_markdown: "## 定义\n...",
    existing_entries: entries,
    kb_ignore_names: [],
    name_similarities: [{ entry_id: "kb_hitl", similarity: 0.95, kind: "concept" }]
  });
  assert.equal(byEmbed.action, "use_existing");
  if (byEmbed.action === "use_existing") assert.equal(byEmbed.via, "embedding");

  const ignored = decideAlignment({
    match: "new",
    name: "临时笔记",
    existing_entries: entries,
    kb_ignore_names: ["临时笔记"]
  });
  assert.equal(ignored.action, "discard");

  const created = decideAlignment({
    match: "new",
    name: "Interrupt",
    existing_entries: entries,
    kb_ignore_names: [],
    name_similarities: [{ entry_id: "kb_hitl", similarity: 0.5 }]
  });
  assert.equal(created.action, "create_new");

  const staleVector = decideAlignment({
    match: "new",
    name: "LLM Wiki",
    existing_entries: entries,
    kb_ignore_names: [],
    name_similarities: [{ entry_id: "kb_deleted", similarity: 0.99 }]
  });
  assert.equal(staleVector.action, "create_new");

  assert.equal(demoteNewBodyToSupplement("正文").heading, "## 补充");
});

test("⑥ patch applicator: append / add / replace + missing heading degrade", () => {
  const appended = applyPatchOps({
    body_markdown: BODY,
    ops: [{ op: "append_to_section", section: "## 实现方式", markdown: "SqliteSaver 用于生产。" }],
    patch_count: 0
  });
  assert.match(appended.body_markdown, /SqliteSaver 用于生产/);
  assert.equal(appended.patch_count, 1);
  assert.equal(appended.degraded_ops.length, 0);

  const added = applyPatchOps({
    body_markdown: BODY,
    ops: [
      {
        op: "add_section",
        after: "## 定义",
        heading: "## 与 interrupt 的关系",
        markdown: "interrupt 依赖 checkpoint。"
      }
    ]
  });
  assert.match(added.body_markdown, /与 interrupt 的关系/);
  assert.ok(added.body_markdown.indexOf("与 interrupt 的关系") < added.body_markdown.indexOf("实现方式"));

  const replaced = applyPatchOps({
    body_markdown: BODY,
    ops: [{ op: "replace_section", section: "## 定义", markdown: "更新后的定义。" }]
  });
  assert.match(replaced.body_markdown, /更新后的定义/);
  assert.equal(replaced.replaced_sections.length, 1);
  assert.match(replaced.replaced_sections[0]!.previous_markdown, /持久化快照/);

  const degraded = applyPatchOps({
    body_markdown: BODY,
    ops: [{ op: "append_to_section", section: "## 不存在的章节", markdown: "落到文末。" }]
  });
  assert.equal(degraded.degraded_ops.length, 1);
  assert.match(degraded.body_markdown, /不存在的章节/);
  assert.match(degraded.body_markdown, /落到文末/);
});

test("⑥ user_edited writes 整理建议 without changing original sections", () => {
  const result = applyPatchOps({
    body_markdown: BODY,
    ops: [{ op: "append_to_section", section: "## 实现方式", markdown: "不应直接写入正文。" }],
    user_edited: true,
    patch_count: 2
  });
  assert.equal(result.wrote_suggestion, true);
  assert.match(result.body_markdown, new RegExp(SUGGESTION_HEADING));
  assert.match(result.body_markdown, /不应直接写入正文/);
  // Original section body unchanged
  const impl = result.body_markdown.split("## 实现方式")[1]!.split("##")[0]!;
  assert.match(impl, /MemorySaver/);
  assert.doesNotMatch(impl, /不应直接写入正文/);
  assert.equal(result.patch_count, 3);
});
