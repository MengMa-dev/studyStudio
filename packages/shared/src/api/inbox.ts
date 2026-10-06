import { z } from "zod";

/** Collect-box item types for the workbench list (document reserved for study area). */
export const inboxItemTypeSchema = z.enum(["webpage", "conversation", "document"]);
export type InboxItemType = z.infer<typeof inboxItemTypeSchema>;

export const readStatusSchema = z.enum(["unread", "read"]);
export type ReadStatus = z.infer<typeof readStatusSchema>;

/** `failed` is shown as pending in the UI. */
export const organizeStatusSchema = z.enum(["pending", "ingested", "rejected", "failed"]);
export type OrganizeStatus = z.infer<typeof organizeStatusSchema>;

export const inboxListTypeFilterSchema = z.enum(["all", "webpage", "conversation"]);
export type InboxListTypeFilter = z.infer<typeof inboxListTypeFilterSchema>;

/** Independent of type filter; fuzzy notes only appear when status is `all`. */
export const inboxListStatusFilterSchema = z.enum(["all", "unread", "read", "pending", "ingested", "rejected"]);
export type InboxListStatusFilter = z.infer<typeof inboxListStatusFilterSchema>;

export const inboxListRowKindSchema = z.enum(["item", "fuzzy_note"]);
export type InboxListRowKind = z.infer<typeof inboxListRowKindSchema>;

export const inboxItemListRowSchema = z.object({
  kind: z.literal("item"),
  id: z.string().min(1),
  type: inboxItemTypeSchema,
  title: z.string(),
  url: z.string().nullable(),
  site: z.string().nullable(),
  capturedAt: z.string(),
  readStatus: readStatusSchema,
  organizeStatus: organizeStatusSchema,
  dirty: z.boolean(),
  tags: z.array(z.string()),
  readingTotalSeconds: z.number().int().nonnegative(),
  readingSessionCount: z.number().int().nonnegative()
});
export type InboxItemListRow = z.infer<typeof inboxItemListRowSchema>;

export const inboxFuzzyNoteListRowSchema = z.object({
  kind: z.literal("fuzzy_note"),
  id: z.string().min(1),
  text: z.string(),
  origin: z.string(),
  createdAt: z.string()
});
export type InboxFuzzyNoteListRow = z.infer<typeof inboxFuzzyNoteListRowSchema>;

export const inboxListRowSchema = z.discriminatedUnion("kind", [inboxItemListRowSchema, inboxFuzzyNoteListRowSchema]);
export type InboxListRow = z.infer<typeof inboxListRowSchema>;

export const inboxCursorSchema = z.object({
  capturedAt: z.string(),
  id: z.string().min(1)
});
export type InboxCursor = z.infer<typeof inboxCursorSchema>;

export const inboxListQuerySchema = z.object({
  type: inboxListTypeFilterSchema.default("all"),
  status: inboxListStatusFilterSchema.default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const inboxListResponseSchema = z.object({
  rows: z.array(inboxListRowSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative()
});
export type InboxListResponse = z.infer<typeof inboxListResponseSchema>;

export const readingSessionSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  seconds: z.number().int().nonnegative(),
  isFirst: z.boolean()
});
export type ReadingSession = z.infer<typeof readingSessionSchema>;

export const noteSummarySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["fuzzy", "item", "entry"]),
  targetId: z.string().nullable(),
  text: z.string(),
  origin: z.string(),
  /** Entry notes only: section id the note is pinned to; null = whole-entry note. */
  anchor: z.string().nullable().optional(),
  usedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable()
});
export type NoteSummary = z.infer<typeof noteSummarySchema>;

export const relatedEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mastery: z.number().min(0).max(1).nullable()
});
export type RelatedEntry = z.infer<typeof relatedEntrySchema>;

export const inboxItemDetailSchema = z.object({
  id: z.string().min(1),
  type: inboxItemTypeSchema,
  title: z.string(),
  url: z.string().nullable(),
  site: z.string().nullable(),
  capturedAt: z.string(),
  reason: z.string().nullable(),
  readStatus: readStatusSchema,
  organizeStatus: organizeStatusSchema,
  dirty: z.boolean(),
  tags: z.array(z.string()),
  readingTotalSeconds: z.number().int().nonnegative(),
  readingSessionCount: z.number().int().nonnegative(),
  lastReadAt: z.string().nullable(),
  markdown: z.string().nullable(),
  question: z.string().nullable(),
  reasoning: z.string().nullable(),
  editedAt: z.string().nullable(),
  unusedNoteCount: z.number().int().nonnegative(),
  readingSessions: z.array(readingSessionSchema),
  notes: z.array(noteSummarySchema),
  relatedEntries: z.array(relatedEntrySchema)
});
export type InboxItemDetail = z.infer<typeof inboxItemDetailSchema>;

export const inboxItemPatchSchema = z
  .object({
    readStatus: readStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    markdown: z.string().max(500_000).optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field required" });
export type InboxItemPatch = z.infer<typeof inboxItemPatchSchema>;

export const inboxBulkActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read_status"),
    ids: z.array(z.string().min(1)).min(1),
    readStatus: readStatusSchema
  }),
  z.object({
    action: z.literal("tags"),
    ids: z.array(z.string().min(1)).min(1),
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
    mode: z.enum(["add", "set"]).default("add")
  })
]);
export type InboxBulkAction = z.infer<typeof inboxBulkActionSchema>;

export const inboxBulkResponseSchema = z.object({
  updated: z.number().int().nonnegative()
});
export type InboxBulkResponse = z.infer<typeof inboxBulkResponseSchema>;

export const deleteRuleKindSchema = z.enum(["none", "url", "domain"]);
export type DeleteRuleKind = z.infer<typeof deleteRuleKindSchema>;

export const deleteImpactQuerySchema = z.object({
  ids: z.string().min(1)
});
export type DeleteImpactQuery = z.infer<typeof deleteImpactQuerySchema>;

export const deleteImpactResponseSchema = z.object({
  itemCount: z.number().int().nonnegative(),
  noteCount: z.number().int().nonnegative(),
  entriesToDelete: z.array(z.object({ id: z.string(), name: z.string() })),
  entriesToStale: z.array(z.object({ id: z.string(), name: z.string() })),
  entriesToOrphan: z.array(z.object({ id: z.string(), name: z.string() })),
  evidenceCount: z.number().int().nonnegative()
});
export type DeleteImpactResponse = z.infer<typeof deleteImpactResponseSchema>;

export const deleteItemsRequestSchema = z.object({
  ids: z.array(z.string().min(1)).default([]),
  noteIds: z.array(z.string().min(1)).default([]),
  removeFromKb: z.boolean().default(true),
  rule: deleteRuleKindSchema.default("none")
});
export type DeleteItemsRequest = z.infer<typeof deleteItemsRequestSchema>;

export const deleteItemsResponseSchema = z.object({
  trashId: z.string().min(1),
  deletedItemCount: z.number().int().nonnegative(),
  deletedNoteCount: z.number().int().nonnegative()
});
export type DeleteItemsResponse = z.infer<typeof deleteItemsResponseSchema>;

export const INBOX_API = {
  list: "/v1/workbench/items",
  detail: (id: string) => `/v1/workbench/items/${encodeURIComponent(id)}`,
  patch: (id: string) => `/v1/workbench/items/${encodeURIComponent(id)}`,
  bulk: "/v1/workbench/items/bulk",
  impact: "/v1/workbench/items/impact",
  delete: "/v1/workbench/items"
} as const;
