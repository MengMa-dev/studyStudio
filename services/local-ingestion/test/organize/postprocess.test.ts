import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyValueScoreFallback,
  constrainAdoptDecision,
  decideAfterLearningJudge,
  decideSegmentCorrection,
  engagementThreshold,
  knowledgeProcessingOutputSchema,
  learningJudgeOutputSchema
} from "../../src/domains/organize/index.js";

test("⑤ τ by engagement and uncertain boost", () => {
  assert.equal(engagementThreshold("strong"), 0.4);
  assert.equal(engagementThreshold("medium"), 0.5);
  assert.equal(engagementThreshold("weak"), 0.6);
  assert.equal(engagementThreshold("strong", true), 0.6);
  assert.equal(engagementThreshold("weak", true), 0.8);
});

test("⑤ value_score < τ overrides new/supplement to reject", () => {
  const hit = applyValueScoreFallback({
    decision: "new",
    value_score: 0.35,
    engagement: "strong"
  });
  assert.equal(hit.overridden, true);
  assert.equal(hit.decision, "reject");
  assert.equal(hit.reject_reason, "low_information");

  const ok = applyValueScoreFallback({
    decision: "supplement",
    value_score: 0.55,
    engagement: "medium"
  });
  assert.equal(ok.overridden, false);
  assert.equal(ok.decision, "supplement");

  const adopt = applyValueScoreFallback({
    decision: "new",
    value_score: 0.1,
    engagement: "weak",
    adopt_mode: true
  });
  assert.equal(adopt.overridden, false);
  assert.equal(adopt.decision, "new");
});

test("⑤ adopt mode forbids reject", () => {
  assert.deepEqual(constrainAdoptDecision("supplement"), { ok: true, decision: "supplement" });
  assert.equal(constrainAdoptDecision("reject").ok, false);
});

test("⑤ segment_suggestion at most one correction round", () => {
  assert.deepEqual(decideSegmentCorrection({ action: "keep" }, false), {
    shouldApply: false,
    shouldRejudge: false,
    reason: "keep"
  });
  assert.equal(decideSegmentCorrection({ action: "split", at: "20:25" }, false).shouldRejudge, true);
  assert.equal(decideSegmentCorrection({ action: "merge", with_episode_id: "ep_2" }, true).shouldApply, false);
});

test("③ confidence branches and note/highlight兜底", () => {
  assert.equal(
    decideAfterLearningJudge({
      is_learning: false,
      confidence: 0.9,
      worth_extracting: true,
      candidate_item_ids: []
    }).action,
    "reject_episode"
  );
  assert.equal(
    decideAfterLearningJudge({
      is_learning: true,
      confidence: 0.5,
      worth_extracting: true,
      candidate_item_ids: ["a"]
    }).action,
    "proceed_uncertain"
  );
  const protected_ = decideAfterLearningJudge({
    is_learning: false,
    confidence: 0.2,
    worth_extracting: false,
    candidate_item_ids: [],
    protected_item_ids: ["item_note"]
  });
  assert.equal(protected_.action, "proceed");
  assert.deepEqual(protected_.force_include_item_ids, ["item_note"]);
});

test("schemas: learning judge + knowledge processing discriminated union", () => {
  const judge = learningJudgeOutputSchema.parse({
    episode_id: "ep_1",
    is_learning: true,
    confidence: 0.94,
    topic: "LangGraph",
    learning_goal: "理解 interrupt 与 checkpoint",
    related_exploration: ["checkpoint", "interrupt"],
    distractions: [{ start: "20:25", duration_sec: 300, type: "unrelated_browsing" }],
    returned_to_topic: true,
    signals_observed: ["active_search", "note"],
    segment_suggestion: { action: "keep" },
    worth_extracting: true,
    candidate_item_ids: ["item_A"],
    item_engagement: { item_A: "strong" },
    reason: "围绕 Agent 架构主动搜索"
  });
  assert.equal(judge.is_learning, true);

  const supplement = knowledgeProcessingOutputSchema.parse({
    item_id: "item_C",
    decision: "supplement",
    value_score: 0.74,
    reason: "补充 checkpoint 关系",
    item_summary: "HITL 依赖 checkpoint",
    item_points: ["interrupt 需 checkpointer"],
    concepts: [
      {
        name: "Human-in-the-loop",
        match: "kb_hitl",
        evidence: [{ quote: "interrupt() pauses" }],
        patch: {
          ops: [{ op: "append_to_section", section: "## 实现方式", markdown: "依赖 checkpoint。" }],
          summary: null
        }
      }
    ],
    relations: []
  });
  assert.equal(supplement.decision, "supplement");

  const reject = knowledgeProcessingOutputSchema.parse({
    item_id: "item_x",
    decision: "reject",
    value_score: 0.1,
    reason: "一次性报错",
    reject_reason: "transient"
  });
  assert.equal(reject.decision, "reject");

  const created = knowledgeProcessingOutputSchema.parse({
    item_id: "item_new",
    decision: "new",
    value_score: 0.8,
    reason: "新概念",
    item_summary: "Interrupt",
    item_points: ["暂停执行"],
    concepts: [
      {
        name: "interrupt()",
        match: "new",
        summary: "暂停图执行",
        body_markdown: "## 用法\ninterrupt()",
        completeness: { covered: ["用法"], missing: ["恢复语义"] },
        evidence: [{ quote: "interrupt() pauses" }]
      }
    ],
    relations: []
  });
  assert.equal(created.decision, "new");
  assert.equal(created.concepts[0]?.match, "new");
});
