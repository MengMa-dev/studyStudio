import { z } from "zod";
import { collectorSettingsSchema, exclusionRuleSchema } from "../settings";

export { eventBatchRequestSchema, eventBatchResultSchema, MAX_BATCH_EVENTS, MAX_BATCH_BYTES } from "../events";
export type { EventBatchResult } from "../events";

export const pairingResponseSchema = z.object({ paired: z.literal(true) });
export type PairingResponse = z.infer<typeof pairingResponseSchema>;

export const pageLookupResponseSchema = z.object({ captured: z.boolean() });
export type PageLookupResponse = z.infer<typeof pageLookupResponseSchema>;

export const ingestAcceptedSchema = z.object({
  accepted: z.literal(true),
  id: z.string().optional(),
  artifact: z.string().optional(),
  itemId: z.string().optional(),
  duplicate: z.boolean().optional(),
  duplicatePage: z.boolean().optional(),
  ignored: z.boolean().optional(),
  noteId: z.string().optional(),
  scope: z.enum(["fuzzy", "item", "entry"]).optional(),
  readingStats: z
    .object({
      totalActiveSeconds: z.number(),
      sessionCount: z.number(),
      lastReadAt: z.string().optional()
    })
    .optional()
});
export type IngestAccepted = z.infer<typeof ingestAcceptedSchema>;

export const presenceRequestSchema = z.object({
  title: z.string().optional(),
  url: z.string().min(1),
  visibleSeconds: z.number().min(0).optional(),
  captured: z.boolean().optional(),
  key: z.string().optional()
});
export type PresenceRequest = z.infer<typeof presenceRequestSchema>;

export const presenceEntrySchema = z.object({
  title: z.string(),
  url: z.string(),
  visibleSeconds: z.number(),
  captured: z.boolean(),
  updatedAt: z.string()
});

export const presenceListResponseSchema = z.object({ entries: z.array(presenceEntrySchema) });
export type PresenceListResponse = z.infer<typeof presenceListResponseSchema>;

export const rulesListResponseSchema = z.object({ rules: z.array(exclusionRuleSchema) });
export type RulesListResponse = z.infer<typeof rulesListResponseSchema>;

export const settingsResponseSchema = collectorSettingsSchema;
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
