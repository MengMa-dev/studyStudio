import { z } from "zod";

const engagement = z.enum(["strong", "medium", "weak"]);

const segmentSuggestionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }),
  z.object({ action: z.literal("split"), at: z.string() }),
  z.object({ action: z.literal("merge"), with_episode_id: z.string() })
]);

/**
 * ③ Learning Judge output schema (07).
 * Used by prompts / gateway `generateObject`.
 */
export const learningJudgeOutputSchema = z.object({
  episode_id: z.string(),
  is_learning: z.boolean(),
  confidence: z.number().min(0).max(1),
  topic: z.string(),
  learning_goal: z.string(),
  related_exploration: z.array(z.string()),
  distractions: z.array(
    z.object({
      start: z.string(),
      duration_sec: z.number().finite().min(0),
      type: z.string()
    })
  ),
  returned_to_topic: z.boolean(),
  signals_observed: z.array(z.string()),
  segment_suggestion: segmentSuggestionSchema,
  worth_extracting: z.boolean(),
  candidate_item_ids: z.array(z.string()),
  item_engagement: z.record(z.string(), engagement),
  reason: z.string()
});
export type LearningJudgeOutput = z.infer<typeof learningJudgeOutputSchema>;

const evidenceSchema = z.object({
  quote: z.string(),
  question: z.string().optional(),
  turn_item_id: z.string().optional()
});

const completenessSchema = z.object({
  covered: z.array(z.string()),
  missing: z.array(z.string())
});

const patchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_to_section"), section: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("add_section"), after: z.string(), heading: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("replace_section"), section: z.string(), markdown: z.string() })
]);

const patchSchema = z.object({
  ops: z.array(patchOpSchema),
  summary: z.string().nullable(),
  completeness: completenessSchema.optional()
});

const conceptExistingSchema = z.object({
  name: z.string(),
  match: z
    .string()
    .refine((value) => value !== "new", '已有词条 entry_id，不能为 "new"')
    .describe("已有词条 entry_id（来自 related_entries / neighbor_entries）"),
  aliases: z.array(z.string()).optional(),
  kind: z.string().optional(),
  evidence: z.array(evidenceSchema),
  patch: patchSchema
});

const conceptNewSchema = z.object({
  name: z.string(),
  match: z.literal("new"),
  aliases: z.array(z.string()).optional(),
  kind: z.string().optional(),
  category: z.string().optional(),
  summary: z.string(),
  body_markdown: z.string(),
  completeness: completenessSchema,
  evidence: z.array(evidenceSchema)
});

/** Prefer the `new` branch first so match="new" is not swallowed by the entry_id string. */
const conceptSchema = z.union([conceptNewSchema, conceptExistingSchema]);

const relationSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["part_of", "prerequisite", "related", "contrasts"]),
  description: z.string().optional()
});

const commonFields = {
  item_id: z.string(),
  value_score: z.number().min(0).max(1),
  reason: z.string()
};

/**
 * ⑤ Knowledge Processing output schema (07).
 * Top-level discriminated union — gateway wraps for OpenAI-compatible providers (M0).
 */
export const knowledgeProcessingOutputSchema = z.discriminatedUnion("decision", [
  z.object({
    ...commonFields,
    decision: z.literal("new"),
    item_summary: z.string(),
    item_points: z.array(z.string()),
    concepts: z.array(conceptSchema).min(1),
    relations: z.array(relationSchema).default([])
  }),
  z.object({
    ...commonFields,
    decision: z.literal("supplement"),
    item_summary: z.string(),
    item_points: z.array(z.string()),
    concepts: z.array(conceptSchema).min(1),
    relations: z.array(relationSchema).default([])
  }),
  z.object({
    ...commonFields,
    decision: z.literal("duplicate"),
    target_entry_ids: z.array(z.string()).min(1),
    evidence_by_entry: z.record(z.string(), z.array(evidenceSchema)).optional()
  }),
  z.object({
    ...commonFields,
    decision: z.literal("reject"),
    reject_reason: z.enum(["off_topic", "low_information", "navigational", "transient", "ignored"])
  })
]);
export type KnowledgeProcessingOutput = z.infer<typeof knowledgeProcessingOutputSchema>;

export const rejectReasonSchema = z.enum(["off_topic", "low_information", "navigational", "transient", "ignored"]);
export const decisionSchema = z.enum(["new", "supplement", "duplicate", "reject"]);
export const engagementSchema = engagement;
export const patchOpSchemaExport = patchOpSchema;
export type PatchOpSchema = z.infer<typeof patchOpSchema>;
