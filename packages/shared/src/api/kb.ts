import { z } from "zod";

import { inboxItemTypeSchema, noteSummarySchema } from "./inbox";

/** Entry kinds are free-form Chinese names: seeds plus kinds the organize pipeline creates (14 A1). */
export const SEED_KINDS = ["概念", "方法", "算法", "模型", "论文", "工具", "库与框架", "设计模式", "最佳实践", "其他"] as const;
export const OTHER_KIND = "其他";
export const MAX_KINDS = 20;
export const MAX_KIND_LENGTH = 8;
/** Legacy enum codes (pre-005 rows, trash snapshots, models answering in English). */
export const LEGACY_KIND_NAMES: Record<string, string> = {
  concept: "概念",
  method: "方法",
  algorithm: "算法",
  model: "模型",
  paper: "论文",
  tool: "工具",
  library: "库与框架",
  pattern: "设计模式",
  practice: "最佳实践",
  other: "其他"
};

export const kbEntryKindSchema = z.string().trim().min(1).max(MAX_KIND_LENGTH);
export type KbEntryKind = string;

export const kbKindSummarySchema = z.object({ name: z.string(), entryCount: z.number().int().nonnegative(), seed: z.boolean() });
export type KbKindSummary = z.infer<typeof kbKindSummarySchema>;
export const kbKindsResponseSchema = z.object({ kinds: z.array(kbKindSummarySchema) });
export type KbKindsResponse = z.infer<typeof kbKindsResponseSchema>;
/** Rename; when `to` already exists this merges `from` into it. */
export const kbKindRenameSchema = z.object({ from: kbEntryKindSchema, to: kbEntryKindSchema });
export type KbKindRename = z.infer<typeof kbKindRenameSchema>;
export const kbKindRenameResponseSchema = z.object({ updated: z.number().int().nonnegative() });
export type KbKindRenameResponse = z.infer<typeof kbKindRenameResponseSchema>;

export const kbRelationTypeSchema = z.enum(["part_of", "prerequisite", "related", "contrasts"]);
export type KbRelationType = z.infer<typeof kbRelationTypeSchema>;

export const kbMasterySourceSchema = z.enum(["auto", "user"]);
export type KbMasterySource = z.infer<typeof kbMasterySourceSchema>;

export const kbSourceKindSchema = z.enum(["official_doc", "repo", "community", "blog", "ai_answer", "other"]);
export type KbSourceKind = z.infer<typeof kbSourceKindSchema>;

export const kbCompletenessSchema = z.object({
  covered: z.array(z.string()),
  missing: z.array(z.string())
});
export type KbCompleteness = z.infer<typeof kbCompletenessSchema>;

/** Detail shows「建议重新整理」when `patchCount` reaches this value (07 ⑦). */
export const KB_REWRITE_SUGGEST_PATCH_COUNT = 8;

const mastery = z.number().min(0).max(1);

export type KbTreeEntryNode = {
  id: string;
  name: string;
  aliases: string[];
  kind: KbEntryKind;
  summary: string | null;
  mastery: number | null;
  masterySource: KbMasterySource;
  stale: boolean;
  userEdited: boolean;
  /** No surviving source item (`kb_entries.orphan` or zero `kb_entry_sources`). */
  orphan: boolean;
  sourceCount: number;
  /** Entries whose `part_of` edge points at this entry. */
  children: KbTreeEntryNode[];
};

export const kbTreeEntryNodeSchema: z.ZodType<KbTreeEntryNode> = z.object({
  id: z.string().min(1),
  name: z.string(),
  aliases: z.array(z.string()),
  kind: kbEntryKindSchema,
  summary: z.string().nullable(),
  mastery: mastery.nullable(),
  masterySource: kbMasterySourceSchema,
  stale: z.boolean(),
  userEdited: z.boolean(),
  orphan: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  get children() {
    return z.array(kbTreeEntryNodeSchema);
  }
});

export const kbTreeCategoryNodeSchema = z.object({
  /** Null groups entries without a category. */
  id: z.string().min(1).nullable(),
  name: z.string(),
  description: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  avgMastery: mastery.nullable(),
  weakEntryCount: z.number().int().nonnegative(),
  children: z.array(kbTreeEntryNodeSchema)
});
export type KbTreeCategoryNode = z.infer<typeof kbTreeCategoryNodeSchema>;

export const kbFlatEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  aliases: z.array(z.string()),
  kind: kbEntryKindSchema,
  summary: z.string().nullable(),
  mastery: mastery.nullable(),
  masterySource: kbMasterySourceSchema,
  stale: z.boolean(),
  userEdited: z.boolean(),
  orphan: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable()
});
export type KbFlatEntry = z.infer<typeof kbFlatEntrySchema>;

export const kbTreeQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: kbEntryKindSchema.optional()
});
export type KbTreeQuery = z.infer<typeof kbTreeQuerySchema>;

/** `tree` without filters; `flat` (only `entries` filled) when `q` or `kind` is set. */
export const kbTreeResponseSchema = z.object({
  mode: z.enum(["tree", "flat"]),
  categories: z.array(kbTreeCategoryNodeSchema),
  entries: z.array(kbFlatEntrySchema),
  total: z.number().int().nonnegative()
});
export type KbTreeResponse = z.infer<typeof kbTreeResponseSchema>;

export const kbBreadcrumbSchema = z.object({
  type: z.enum(["category", "entry"]),
  id: z.string().nullable(),
  name: z.string()
});
export type KbBreadcrumb = z.infer<typeof kbBreadcrumbSchema>;

export const kbEvidenceSchema = z.object({
  quote: z.string(),
  /** Only for conversation sources. */
  question: z.string().optional(),
  /** Conversation turn to jump back to in the inbox. */
  turnItemId: z.string().optional()
});
export type KbEvidence = z.infer<typeof kbEvidenceSchema>;

export const kbEntrySourceSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  type: inboxItemTypeSchema,
  url: z.string().nullable(),
  site: z.string().nullable(),
  sourceKind: kbSourceKindSchema,
  addedAt: z.string().nullable(),
  evidence: z.array(kbEvidenceSchema)
});
export type KbEntrySource = z.infer<typeof kbEntrySourceSchema>;

export const kbRelationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: kbRelationTypeSchema,
  /** `out`: this entry is the edge `src` (e.g. part_of → parent); `in`: this entry is `dst`. */
  direction: z.enum(["out", "in"]),
  mastery: mastery.nullable(),
  description: z.string().nullable()
});
export type KbRelation = z.infer<typeof kbRelationSchema>;

export const kbEntryBriefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mastery: mastery.nullable()
});
export type KbEntryBrief = z.infer<typeof kbEntryBriefSchema>;

/** Rendered on read from `contrasts` edges and conversation evidence; never stored in `bodyMarkdown`. */
export const kbRenderedSectionsSchema = z.object({
  contrasts: z.array(
    z.object({
      entryId: z.string().min(1),
      name: z.string(),
      description: z.string(),
      sourceItemIds: z.array(z.string())
    })
  ),
  faqs: z.array(
    z.object({
      question: z.string(),
      itemId: z.string().min(1),
      turnItemId: z.string().nullable()
    })
  )
});
export type KbRenderedSections = z.infer<typeof kbRenderedSectionsSchema>;

export const kbEntryDetailSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  aliases: z.array(z.string()),
  kind: kbEntryKindSchema,
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  breadcrumb: z.array(kbBreadcrumbSchema),
  summary: z.string().nullable(),
  bodyMarkdown: z.string(),
  renderedSections: kbRenderedSectionsSchema,
  completeness: kbCompletenessSchema.nullable(),
  mastery: mastery.nullable(),
  masterySource: kbMasterySourceSchema,
  userEdited: z.boolean(),
  /** Edited since the last organize run; shows the pending-organize bar. */
  dirty: z.boolean(),
  stale: z.boolean(),
  orphan: z.boolean(),
  patchCount: z.number().int().nonnegative(),
  suggestRewrite: z.boolean(),
  updatedAt: z.string().nullable(),
  notes: z.array(noteSummarySchema),
  sources: z.array(kbEntrySourceSchema),
  relations: z.array(kbRelationSchema),
  sameCategory: z.array(kbEntryBriefSchema)
});
export type KbEntryDetail = z.infer<typeof kbEntryDetailSchema>;

/** `mastery: null` restores automatic estimation (`mastery_source=auto`). */
export const kbEntryPatchSchema = z
  .object({
    bodyMarkdown: z.string().max(500_000).optional(),
    mastery: mastery.nullable().optional(),
    categoryId: z.string().min(1).nullable().optional(),
    kind: kbEntryKindSchema.optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field required" });
export type KbEntryPatch = z.infer<typeof kbEntryPatchSchema>;

/** `ids` is comma-separated. */
export const kbDeleteImpactQuerySchema = z.object({
  ids: z.string().min(1)
});
export type KbDeleteImpactQuery = z.infer<typeof kbDeleteImpactQuerySchema>;

export const kbDeleteImpactResponseSchema = z.object({
  entries: z.array(z.object({ id: z.string(), name: z.string() })),
  noteCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  /** Children move up to the nearest surviving parent; `newParentId` null means category root. */
  reparentedChildren: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      newParentId: z.string().nullable(),
      newParentName: z.string().nullable()
    })
  ),
  /** Source items stay in the inbox. */
  sourceItemCount: z.number().int().nonnegative()
});
export type KbDeleteImpactResponse = z.infer<typeof kbDeleteImpactResponseSchema>;

export const kbDeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /** Write names to `kb_ignore` so future organize runs skip them. */
  ignore: z.boolean().default(false)
});
export type KbDeleteRequest = z.infer<typeof kbDeleteRequestSchema>;
export type KbDeleteRequestInput = z.input<typeof kbDeleteRequestSchema>;

export const kbDeleteResponseSchema = z.object({
  trashId: z.string().min(1),
  deletedEntryCount: z.number().int().nonnegative()
});
export type KbDeleteResponse = z.infer<typeof kbDeleteResponseSchema>;

export const kbGraphResponseSchema = z.object({
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: kbEntryKindSchema,
      categoryId: z.string().nullable(),
      mastery: mastery.nullable(),
      stale: z.boolean(),
      orphan: z.boolean()
    })
  ),
  edges: z.array(z.object({ src: z.string(), dst: z.string(), type: kbRelationTypeSchema }))
});
export type KbGraphResponse = z.infer<typeof kbGraphResponseSchema>;

export const KB_API = {
  tree: "/v1/kb/tree",
  graph: "/v1/kb/graph",
  kinds: "/v1/kb/kinds",
  entry: (id: string) => `/v1/kb/entries/${encodeURIComponent(id)}`,
  patch: (id: string) => `/v1/kb/entries/${encodeURIComponent(id)}`,
  impact: "/v1/kb/entries/impact",
  delete: "/v1/kb/entries"
} as const;
