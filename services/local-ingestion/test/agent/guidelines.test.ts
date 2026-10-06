import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGENT_GUIDELINES_VERSION, buildGuidelines } from "../../src/domains/agent/guidelines.js";
import { SKILL_MARKDOWN } from "../../src/domains/agent/skill.js";
import { AGENT_SKILL_VERSION } from "../../src/domains/agent/tools.js";

test("guidelines follow the LLM Wiki flow and reference the write tools", () => {
  const { version, markdown } = buildGuidelines();
  assert.equal(version, AGENT_GUIDELINES_VERSION);
  assert.ok(markdown.includes(version));
  for (const phrase of ["等待确认", "优先更新已有词条", "⚠ 与", "source_item_ids", "write_entry", "attach_source", "add_relation", "finish_unit"]) {
    assert.ok(markdown.includes(phrase), phrase);
  }
  assert.doesNotMatch(markdown, /submit_decision|只输出 JSON/);
});

test("skill v3: confirm-then-write flow, repo copy in sync", () => {
  assert.equal(AGENT_SKILL_VERSION, 3);
  assert.equal(readFileSync(new URL("../../../../skills/organize-kb/SKILL.md", import.meta.url), "utf8"), SKILL_MARKDOWN);
  assert.match(SKILL_MARKDOWN, /\nskillVersion: 3\n/);
  for (const tool of ["get_unit", "write_entry", "attach_source", "add_relation", "finish_unit", "等待确认"]) assert.ok(SKILL_MARKDOWN.includes(tool), tool);
  assert.doesNotMatch(SKILL_MARKDOWN, /submit_decision|chunks/);
});
