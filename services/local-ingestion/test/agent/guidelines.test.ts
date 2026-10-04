import assert from "node:assert/strict";
import { test } from "node:test";
import * as compose from "../../src/ai/prompts/knowledge-compose.js";
import * as extract from "../../src/ai/prompts/knowledge-extract.js";
import * as triage from "../../src/ai/prompts/knowledge-triage.js";
import { AGENT_GUIDELINES_VERSION, buildGuidelines } from "../../src/domains/agent/guidelines.js";
import { PROCESSING_PROMPT_VERSION } from "../../src/domains/organize/process.js";

test("prompt SYSTEM is exactly RULES + OUTPUT", () => {
  for (const prompt of [triage, extract, compose]) {
    assert.equal(prompt.SYSTEM, prompt.RULES + prompt.OUTPUT);
    assert.match(prompt.OUTPUT, /只输出 JSON/);
    assert.doesNotMatch(prompt.RULES, /只输出 JSON/);
  }
});

test("all-stage guidelines contain every rule body without output conventions", () => {
  const { version, markdown } = buildGuidelines("all");
  assert.equal(version, AGENT_GUIDELINES_VERSION);
  assert.ok(version.includes(PROCESSING_PROMPT_VERSION));
  assert.ok(markdown.includes(version));
  for (const prompt of [triage, extract, compose]) assert.ok(markdown.includes(prompt.RULES));
  assert.ok(!markdown.includes("只输出 JSON"));
  for (const heading of ["## 判定", "## 抽取知识点", "## 组织写作", "## Agent 补充约束"]) assert.ok(markdown.includes(heading));
  assert.match(markdown, /submit_decision/);
});

test("single-stage guidelines contain only that stage's rules", () => {
  const cases = [
    ["triage", triage],
    ["extract", extract],
    ["compose", compose]
  ] as const;
  for (const [stage, prompt] of cases) {
    const { markdown } = buildGuidelines(stage);
    for (const other of [triage, extract, compose]) assert.equal(markdown.includes(other.RULES), other === prompt, stage);
    assert.match(markdown, /## Agent 补充约束/);
  }
});
