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

const patchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_to_section"), section: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("add_section"), after: z.string(), heading: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("replace_section"), section: z.string(), markdown: z.string() })
]);

export const rejectReasonSchema = z.enum(["off_topic", "low_information", "navigational", "transient", "ignored"]);
export const decisionSchema = z.enum(["new", "supplement", "duplicate", "reject"]);
export const engagementSchema = engagement;
export const patchOpSchemaExport = patchOpSchema;
export type PatchOpSchema = z.infer<typeof patchOpSchema>;
