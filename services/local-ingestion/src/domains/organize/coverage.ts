import type { KnowledgeComposeOutput, KnowledgeProcessingOutput, PointImportance } from "../../ai/prompts/schemas.draft.js";

/** ⑤ S5 (15): compose output validation, coverage of extracted points, assembly into the ⑥ input. */

export type KnowledgePoint = {
  id: string;
  statement: string;
  quote: string;
  section: string | null;
  concept: string;
  importance: PointImportance;
  turn_item_id: string | null;
  question: string | null;
};

type Evidence = { quote: string; question: string | null; turn_item_id: string | null; point: string; importance: PointImportance };

const required = (point: KnowledgePoint) => point.importance !== "detail";

/** Problems to send back as compose `feedback`; empty = valid. */
export function validateCompose(out: KnowledgeComposeOutput, points: KnowledgePoint[], knownEntryIds: Set<string>): string[] {
  const byId = new Map(points.map((point) => [point.id, point]));
  const hasCore = points.some((point) => point.importance === "core");
  const problems: string[] = [];
  for (const concept of out.concepts) {
    const unknown = concept.point_ids.filter((id) => !byId.has(id));
    if (unknown.length) problems.push(`概念「${concept.name}」引用了不存在的知识点：${unknown.join("、")}`);
    if (concept.match !== "new") {
      if (!knownEntryIds.has(concept.match)) problems.push(`概念「${concept.name}」的 match「${concept.match}」不在候选词条中，请改为候选 entry_id 或 "new"`);
      if (!concept.patch && concept.body_markdown) problems.push(`已有词条「${concept.name}」应使用 patch 写增量，而不是 body_markdown`);
      continue;
    }
    const missing = (["summary", "body_markdown", "category"] as const).filter((field) => !concept[field]);
    if (missing.length) problems.push(`新词条「${concept.name}」缺少 ${missing.join(" / ")}`);
    if (hasCore && !concept.point_ids.some((id) => byId.get(id)?.importance === "core")) {
      problems.push(`新词条「${concept.name}」不含 core 知识点，应并入已有词条或本次新建的词条`);
    }
  }
  const unknownDropped = out.dropped.map((entry) => entry.point_id).filter((id) => !byId.has(id));
  if (unknownDropped.length) problems.push(`dropped 引用了不存在的知识点：${unknownDropped.join("、")}`);
  return problems;
}

/** core / supporting points neither assigned to a concept nor dropped with a reason. */
export function missingPoints(out: KnowledgeComposeOutput, points: KnowledgePoint[]): KnowledgePoint[] {
  const accounted = new Set([...out.concepts.flatMap((concept) => concept.point_ids), ...out.dropped.map((entry) => entry.point_id)]);
  return points.filter((point) => required(point) && !accounted.has(point.id));
}

export function missingFeedback(points: KnowledgePoint[]): string {
  return `以下要点未写入任何词条，也未在 dropped 中说明理由，请分配或说明：${points.map((point) => `${point.id}「${point.statement}」`).join("；")}`;
}

function toEvidence(point: KnowledgePoint): Evidence {
  return { quote: point.quote, question: point.question, turn_item_id: point.turn_item_id, point: point.statement, importance: point.importance };
}

export function assembleResult(
  out: KnowledgeComposeOutput,
  points: KnowledgePoint[],
  meta: { item_id: string; value_score: number; reason: string }
): KnowledgeProcessingOutput {
  const byId = new Map(points.map((point) => [point.id, point]));
  const evidenceOf = (ids: string[]) => ids.flatMap((id) => (byId.has(id) ? [toEvidence(byId.get(id)!)] : []));
  const concepts = out.concepts
    .map((concept) => ({
      name: concept.name,
      match: concept.match,
      aliases: concept.aliases,
      kind: concept.kind,
      evidence: evidenceOf(concept.point_ids),
      patch: concept.patch,
      category: concept.category,
      summary: concept.summary,
      body_markdown: concept.body_markdown,
      completeness: concept.completeness
    }))
    .filter((concept) => concept.evidence.length > 0);

  if (concepts.some((concept) => concept.match === "new" || concept.patch)) {
    return {
      ...meta,
      decision: concepts.some((concept) => concept.match === "new") ? "new" : "supplement",
      item_summary: out.item_summary,
      item_points: out.item_points,
      concepts,
      relations: out.relations
    };
  }

  const byEntry = new Map<string, Evidence[]>();
  const add = (entryId: string, evidence: Evidence[]) => byEntry.set(entryId, [...(byEntry.get(entryId) ?? []), ...evidence]);
  for (const concept of concepts) add(concept.match, concept.evidence);
  for (const entry of out.dropped) if (entry.reason === "covered" && entry.entry_id) add(entry.entry_id, evidenceOf([entry.point_id]));
  const evidence = [...byEntry].filter(([, items]) => items.length > 0);
  if (evidence.length === 0) return { ...meta, decision: "reject", reject_reason: "low_information" };
  return {
    ...meta,
    decision: "duplicate",
    target_entry_ids: evidence.map(([entryId]) => entryId),
    evidence_by_entry: evidence.map(([entry_id, items]) => ({ entry_id, evidence: items }))
  };
}
