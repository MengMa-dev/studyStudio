import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeAlignOutput } from "../../src/ai/prompts/schemas.draft";
import { applySplitFixes, checkSplit } from "../../src/domains/organize/verify";

const newEntry = (name: string, kind: string) => ({ key: `new:${name}`, name, aliases: [], kind, category: "知识管理", summary: "" });
const fragments = ["f1", "f2", "f3", "f4", "f5"].map((id) => ({ id, markdown: "原文".repeat(200) }));

function align(entries: string[], extra: Partial<KnowledgeAlignOutput> = {}): KnowledgeAlignOutput {
  return {
    assignments: entries.map((entry, index) => ({ fragment_id: `f${index + 1}`, entry: `new:${entry}`, covered_by: null })),
    new_entries: [newEntry("LLM Wiki", "概念"), newEntry("搭建 LLM Wiki", "方法"), newEntry("LLM Wiki MVP 不需要 Vector DB", "技巧")],
    relations: [
      { from: "搭建 LLM Wiki", to: "LLM Wiki", type: "part_of", description: null },
      { from: "LLM Wiki MVP 不需要 Vector DB", to: "LLM Wiki", type: "part_of", description: null }
    ],
    item_summary: "",
    item_points: [],
    ...extra
  };
}

test("split check: a single fragment sandwiched inside another entry is merged back, proposition names are flagged", () => {
  const output = align(["LLM Wiki", "搭建 LLM Wiki", "LLM Wiki MVP 不需要 Vector DB", "搭建 LLM Wiki", "搭建 LLM Wiki"]);
  const { problems, fixes } = checkSplit(output, fragments);
  assert.deepEqual(fixes, [{ from: "new:LLM Wiki MVP 不需要 Vector DB", into: "new:搭建 LLM Wiki", reason: "sandwiched" }]);
  assert.ok(problems.some((problem) => problem.includes("不是词条级名词")));

  const fixed = applySplitFixes(output, fixes);
  assert.equal(fixed.assignments[2]!.entry, "new:搭建 LLM Wiki");
  assert.deepEqual(
    fixed.new_entries.map((entry) => entry.name),
    ["LLM Wiki", "搭建 LLM Wiki"]
  );
  assert.equal(fixed.relations.length, 1);
});

test("split check: a small part_of child of another new entry is merged into its parent; substantial splits stay", () => {
  const small = align(["LLM Wiki", "LLM Wiki", "LLM Wiki", "LLM Wiki", "LLM Wiki MVP 不需要 Vector DB"]);
  assert.deepEqual(checkSplit(small, fragments).fixes, [{ from: "new:LLM Wiki MVP 不需要 Vector DB", into: "new:LLM Wiki", reason: "too_small" }]);

  const method = align(["LLM Wiki", "LLM Wiki", "搭建 LLM Wiki", "搭建 LLM Wiki", "搭建 LLM Wiki"]);
  assert.deepEqual(checkSplit(method, fragments), { problems: [], fixes: [] });
});
