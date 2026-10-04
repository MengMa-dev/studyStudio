import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeComposeOutput } from "../../src/ai/prompts/schemas.draft.js";
import { assembleResult, missingFeedback, missingPoints, validateCompose, type KnowledgePoint } from "../../src/domains/organize/coverage.js";

type Concept = KnowledgeComposeOutput["concepts"][number];

function pt(id: string, importance: KnowledgePoint["importance"], extra: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return { id, statement: `陈述 ${id}`, quote: `原文 ${id}`, section: null, concept: "位置编码", importance, turn_item_id: null, question: null, ...extra };
}

function newConcept(pointIds: string[], extra: Partial<Concept> = {}): Concept {
  return {
    name: "位置编码",
    match: "new",
    aliases: [],
    kind: "方法",
    point_ids: pointIds,
    patch: null,
    category: "LLM 基础",
    summary: "为 Self-Attention 注入位置信息",
    body_markdown: "## 定义\n…",
    completeness: { covered: ["定义"], missing: [] },
    ...extra
  };
}

function existingConcept(entryId: string, pointIds: string[], withPatch: boolean): Concept {
  return {
    name: "Self-Attention",
    match: entryId,
    aliases: [],
    kind: "概念",
    point_ids: pointIds,
    patch: withPatch ? { ops: [{ op: "append_to_section", section: "## 局限", markdown: "无序" }], summary: null, completeness: null } : null,
    category: null,
    summary: null,
    body_markdown: null,
    completeness: null
  };
}

function compose(partial: Partial<KnowledgeComposeOutput>): KnowledgeComposeOutput {
  return { item_summary: "摘要", item_points: ["要点"], concepts: [], relations: [], dropped: [], ...partial };
}

const META = { item_id: "item_1", value_score: 0.8, reason: "有新知识" };

test("missingPoints: core/supporting must be assigned or dropped; detail is optional", () => {
  const points = [pt("p1", "core"), pt("p2", "supporting"), pt("p3", "detail"), pt("p4", "supporting")];
  const out = compose({ concepts: [newConcept(["p1"])], dropped: [{ point_id: "p4", reason: "trivial", entry_id: null }] });
  assert.deepEqual(
    missingPoints(out, points).map((point) => point.id),
    ["p2"]
  );
  const covered = compose({ concepts: [newConcept(["p1"]), existingConcept("kb_sa", ["p2"], false)], dropped: [{ point_id: "p4", reason: "trivial", entry_id: null }] });
  assert.deepEqual(missingPoints(covered, points), []);
  assert.match(missingFeedback([pt("p2", "supporting")]), /p2「陈述 p2」/);
});

test("validateCompose flags unknown ids, incomplete new entries, non-core new entries, body on existing entries", () => {
  const points = [pt("p1", "core"), pt("p2", "supporting")];
  const known = new Set(["kb_sa"]);
  assert.deepEqual(validateCompose(compose({ concepts: [newConcept(["p1"]), existingConcept("kb_sa", ["p2"], true)] }), points, known), []);

  const problems = validateCompose(
    compose({
      concepts: [
        newConcept(["p9"]),
        existingConcept("kb_unknown", ["p1"], true),
        newConcept(["p2"], { name: "细节概念", body_markdown: null }),
        { ...existingConcept("kb_sa", ["p1"], false), body_markdown: "## 正文" }
      ],
      dropped: [{ point_id: "p8", reason: "trivial", entry_id: null }]
    }),
    points,
    known
  );
  assert.ok(problems.some((p) => p.includes("p9")));
  assert.ok(problems.some((p) => p.includes("kb_unknown")));
  assert.ok(problems.some((p) => p.includes("细节概念") && p.includes("body_markdown")));
  assert.ok(problems.some((p) => p.includes("细节概念") && p.includes("core")));
  assert.ok(problems.some((p) => p.includes("Self-Attention") && p.includes("patch")));
  assert.ok(problems.some((p) => p.includes("p8")));

  const noCore = [pt("p1", "supporting")];
  assert.deepEqual(validateCompose(compose({ concepts: [newConcept(["p1"])] }), noCore, known), [], "no core point in unit → supporting may create");
});

test("assembleResult: new / supplement carry point evidence", () => {
  const points = [pt("p1", "core"), pt("p2", "supporting", { turn_item_id: "turn_2", question: "为什么？" })];
  const created = assembleResult(compose({ concepts: [newConcept(["p1"]), existingConcept("kb_sa", ["p2"], true)] }), points, META);
  assert.equal(created.decision, "new");
  if (created.decision !== "new") return;
  assert.equal(created.concepts.length, 2);
  assert.deepEqual(created.concepts[1]!.evidence, [{ quote: "原文 p2", question: "为什么？", turn_item_id: "turn_2", point: "陈述 p2", importance: "supporting" }]);
  assert.equal(created.item_summary, "摘要");

  const supplemented = assembleResult(compose({ concepts: [existingConcept("kb_sa", ["p1", "p2"], true)] }), points, META);
  assert.equal(supplemented.decision, "supplement");
});

test("assembleResult: nothing written → duplicate on covering entries; nothing at all → reject", () => {
  const points = [pt("p1", "core"), pt("p2", "supporting")];
  const duplicate = assembleResult(
    compose({ concepts: [existingConcept("kb_sa", ["p1"], false)], dropped: [{ point_id: "p2", reason: "covered", entry_id: "kb_pe" }] }),
    points,
    META
  );
  assert.equal(duplicate.decision, "duplicate");
  if (duplicate.decision !== "duplicate") return;
  assert.deepEqual(duplicate.target_entry_ids, ["kb_sa", "kb_pe"]);
  assert.equal(duplicate.evidence_by_entry.find((entry) => entry.entry_id === "kb_pe")!.evidence[0]!.quote, "原文 p2");

  const rejected = assembleResult(compose({ dropped: [{ point_id: "p1", reason: "trivial", entry_id: null }] }), points, META);
  assert.equal(rejected.decision, "reject");
  if (rejected.decision === "reject") assert.equal(rejected.reject_reason, "low_information");
});
