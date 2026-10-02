import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateOrganizeRunStats, computeInputHash, isInputUnchanged, shouldRewriteStaleEntry } from "../../src/domains/organize/index.js";

test("input_hash is stable across key order and note order", () => {
  const judge = {
    episode_id: "ep_1",
    is_learning: true,
    confidence: 0.9,
    topic: "Agent 架构",
    item_engagement: { item_A: "strong", item_B: "medium" }
  };
  const a = computeInputHash({
    content: "## HITL\n正文",
    notes: ["依赖 checkpoint", "前端开发关注点"],
    judge_result: judge,
    prompt_version: "organize-v1"
  });
  const b = computeInputHash({
    content: "## HITL\n正文",
    notes: ["前端开发关注点", "依赖 checkpoint"],
    judge_result: {
      item_engagement: { item_B: "medium", item_A: "strong" },
      topic: "Agent 架构",
      confidence: 0.9,
      is_learning: true,
      episode_id: "ep_1"
    },
    prompt_version: "organize-v1"
  });
  assert.equal(a, b);
  assert.equal(isInputUnchanged(a, b), true);

  const c = computeInputHash({
    content: "## HITL\n正文改了",
    notes: ["依赖 checkpoint", "前端开发关注点"],
    judge_result: judge,
    prompt_version: "organize-v1"
  });
  assert.notEqual(a, c);
  assert.equal(isInputUnchanged(a, c), false);
});

test("stale flag and organize_runs stats aggregation", () => {
  assert.equal(shouldRewriteStaleEntry(1), true);
  assert.equal(shouldRewriteStaleEntry(0), false);

  const stats = aggregateOrganizeRunStats([
    { type: "episode", status: "learning" },
    { type: "episode", status: "non_learning" },
    { type: "episode", status: "deferred" },
    { type: "item", outcome: "ingested", via_prefilter: true },
    { type: "item", outcome: "rejected", reject_reason: "navigational", via_prefilter: true },
    { type: "item", outcome: "failed" },
    { type: "kb", change: "created" },
    { type: "kb", change: "supplemented" },
    { type: "kb", change: "edge" },
    { type: "kb", change: "rewritten" }
  ]);

  assert.equal(stats.episodes_learning, 1);
  assert.equal(stats.episodes_non_learning, 1);
  assert.equal(stats.episodes_deferred, 1);
  assert.equal(stats.items_ingested, 1);
  assert.equal(stats.items_rejected, 1);
  assert.equal(stats.items_failed, 1);
  assert.equal(stats.prefilter_hits, 2);
  assert.equal(stats.kb_entries_created, 1);
  assert.equal(stats.kb_entries_supplemented, 1);
  assert.equal(stats.kb_edges_created, 1);
  assert.equal(stats.kb_entries_rewritten, 1);
  assert.equal(stats.reject_reasons.navigational, 1);
});
