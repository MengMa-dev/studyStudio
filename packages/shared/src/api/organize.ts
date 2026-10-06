import { z } from "zod";

import { organizeSettingsSchema } from "../settings";
import { inboxItemTypeSchema } from "./inbox";

export const organizeTriggerSchema = z.enum(["manual", "daily", "batch", "on_ingest", "catch_up", "retry", "agent"]);
export type OrganizeTrigger = z.infer<typeof organizeTriggerSchema>;

/**
 * Manual dialog scopes (07「手动整理弹窗」).
 * `*_selected` / `item` require `itemIds`; `kb_selected` / `entry` require `entryIds`.
 */
export const organizeScopeSchema = z.enum(["inbox_selected", "inbox_pending", "inbox_all", "kb_selected", "kb_pending", "kb_all", "item", "entry"]);
export type OrganizeScope = z.infer<typeof organizeScopeSchema>;

/** `paused`: hit the daily token limit; remaining items continue the next day. */
export const organizeRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "paused"]);
export type OrganizeRunStatus = z.infer<typeof organizeRunStatusSchema>;

export const organizeStageSchema = z.enum([
  "context",
  "episode",
  "learning_judge",
  "retrieve",
  "knowledge_processing",
  "integration",
  "entry_rewrite",
  "embedding"
]);
export type OrganizeStage = z.infer<typeof organizeStageSchema>;

export const organizeDecisionSchema = z.enum(["new", "supplement", "duplicate", "reject", "not_learning"]);
export type OrganizeDecision = z.infer<typeof organizeDecisionSchema>;

const count = z.number().int().nonnegative();

/** Settings page also shows last/next run and pending counts. */
export const organizeSettingsResponseSchema = z.object({
  settings: organizeSettingsSchema,
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  pendingCount: count,
  dirtyCount: count,
  activeRunId: z.string().nullable()
});
export type OrganizeSettingsResponse = z.infer<typeof organizeSettingsResponseSchema>;

export const organizeSettingsUpdateSchema = z.object({
  autoEnabled: z.boolean().optional(),
  triggers: z
    .object({
      daily: organizeSettingsSchema.shape.triggers.shape.daily.partial().optional(),
      batch: organizeSettingsSchema.shape.triggers.shape.batch.partial().optional(),
      onIngest: organizeSettingsSchema.shape.triggers.shape.onIngest.partial().optional()
    })
    .optional(),
  outputLanguage: organizeSettingsSchema.shape.outputLanguage.optional()
});
export type OrganizeSettingsUpdate = z.infer<typeof organizeSettingsUpdateSchema>;

const scopeNeedsItems = new Set<OrganizeScope>(["inbox_selected", "item"]);
const scopeNeedsEntries = new Set<OrganizeScope>(["kb_selected", "entry"]);

const organizeRunRequestBaseSchema = z.object({
  scope: organizeScopeSchema,
  itemIds: z.array(z.string().min(1)).default([]),
  entryIds: z.array(z.string().min(1)).default([]),
  /** Saved as a note by scope: item → item note, entry → entry note, otherwise fuzzy (`origin=organize_requirement`). */
  requirement: z.string().trim().max(2000).optional(),
  /** User confirmed continuing past the daily token limit. */
  allowOverLimit: z.boolean().default(false)
});

export const organizeRunRequestSchema = organizeRunRequestBaseSchema.superRefine((value, ctx) => {
  if (scopeNeedsItems.has(value.scope) && value.itemIds.length === 0) ctx.addIssue({ code: "custom", path: ["itemIds"], message: "itemIds required" });
  if (scopeNeedsEntries.has(value.scope) && value.entryIds.length === 0) ctx.addIssue({ code: "custom", path: ["entryIds"], message: "entryIds required" });
  if (value.scope === "item" && value.itemIds.length > 1) ctx.addIssue({ code: "custom", path: ["itemIds"], message: "single item scope" });
  if (value.scope === "entry" && value.entryIds.length > 1) ctx.addIssue({ code: "custom", path: ["entryIds"], message: "single entry scope" });
});
export type OrganizeRunRequest = z.infer<typeof organizeRunRequestSchema>;
export type OrganizeRunRequestInput = z.input<typeof organizeRunRequestSchema>;

/** Dialog preview: "本次会使用 n 条收集点/知识点/模糊备注（其中 m 条新加）". */
export const organizePreviewRequestSchema = organizeRunRequestBaseSchema.omit({ requirement: true, allowOverLimit: true });
export type OrganizePreviewRequest = z.infer<typeof organizePreviewRequestSchema>;
export type OrganizePreviewRequestInput = z.input<typeof organizePreviewRequestSchema>;

export const organizePreviewResponseSchema = z.object({
  itemCount: count,
  entryCount: count,
  newItemCount: count,
  editedItemCount: count,
  noteCount: count,
  newNoteCount: count,
  fuzzyNoteCount: count,
  overDailyLimit: z.boolean()
});
export type OrganizePreviewResponse = z.infer<typeof organizePreviewResponseSchema>;

export const organizeStageUsageSchema = z.object({
  stage: organizeStageSchema,
  calls: count,
  inputTokens: count,
  outputTokens: count
});
export type OrganizeStageUsage = z.infer<typeof organizeStageUsageSchema>;

/** Stored as JSON in `organize_runs.stats`. */
export const organizeRunStatsSchema = z.object({
  episodes: z.object({ learning: count, notLearning: count, deferred: count }),
  items: z.object({ total: count, ingested: count, rejected: count, failed: count, skipped: count }),
  decisions: z.object({ new: count, supplement: count, duplicate: count, reject: count, notLearning: count, prefiltered: count }),
  kb: z.object({ entriesCreated: count, relationsCreated: count, entriesSupplemented: count, entriesRewritten: count }),
  stages: z.array(organizeStageUsageSchema)
});
export type OrganizeRunStats = z.infer<typeof organizeRunStatsSchema>;

export const organizeProgressSchema = z.object({
  stage: organizeStageSchema.nullable(),
  done: count,
  total: count
});
export type OrganizeProgress = z.infer<typeof organizeProgressSchema>;

export const organizeRunSummarySchema = z.object({
  id: z.string().min(1),
  trigger: organizeTriggerSchema,
  scope: organizeScopeSchema.nullable(),
  requirement: z.string().nullable(),
  status: organizeRunStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  tokens: count,
  model: z.string().nullable(),
  stats: organizeRunStatsSchema,
  progress: organizeProgressSchema.nullable()
});
export type OrganizeRunSummary = z.infer<typeof organizeRunSummarySchema>;

export const organizeRunItemStatusSchema = z.enum(["pending", "ingested", "rejected", "failed", "skipped"]);
export type OrganizeRunItemStatus = z.infer<typeof organizeRunItemStatusSchema>;

export const organizeRunItemSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  type: inboxItemTypeSchema,
  status: organizeRunItemStatusSchema,
  decision: organizeDecisionSchema.nullable(),
  /** `prefilter:<rule>` | `llm` | `llm_long`. */
  route: z.string().nullable(),
  entryIds: z.array(z.string()),
  error: z.string().nullable()
});
export type OrganizeRunItem = z.infer<typeof organizeRunItemSchema>;

export const organizeRunEntryChangeSchema = z.object({
  entryId: z.string().min(1),
  name: z.string(),
  change: z.enum(["created", "supplemented", "duplicate", "rewritten"])
});
export type OrganizeRunEntryChange = z.infer<typeof organizeRunEntryChangeSchema>;

export const organizeRunFailureSchema = z.object({
  jobId: z.string().min(1),
  kind: z.string(),
  targetId: z.string().nullable(),
  attempts: count,
  error: z.string()
});
export type OrganizeRunFailure = z.infer<typeof organizeRunFailureSchema>;

export const organizeRunDetailSchema = organizeRunSummarySchema.extend({
  items: z.array(organizeRunItemSchema),
  entries: z.array(organizeRunEntryChangeSchema),
  failures: z.array(organizeRunFailureSchema)
});
export type OrganizeRunDetail = z.infer<typeof organizeRunDetailSchema>;

/**
 * One recorded step of a run (`organize_traces`). `step` is an LLM task name
 * (`learning_judge` / `knowledge_extract` / `knowledge_align` / `entry_rewrite`)
 * or a program step (`context` / `episodes` / `judge_cached` / `judge_verdict` / `retrieve` / `processing_result` / `integration` / `skipped`).
 */
export const organizeTraceStepSchema = z.object({
  seq: count,
  stage: organizeStageSchema,
  step: z.string(),
  itemIds: z.array(z.string()),
  episodeId: z.string().nullable(),
  entryId: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  model: z.string().nullable(),
  inputTokens: count,
  outputTokens: count,
  createdAt: z.string().nullable()
});
export type OrganizeTraceStep = z.infer<typeof organizeTraceStepSchema>;

export const organizeRunTraceResponseSchema = z.object({ steps: z.array(organizeTraceStepSchema) });
export type OrganizeRunTraceResponse = z.infer<typeof organizeRunTraceResponseSchema>;

export const organizeRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
export type OrganizeRunsQuery = z.infer<typeof organizeRunsQuerySchema>;

export const organizeRunsResponseSchema = z.object({
  runs: z.array(organizeRunSummarySchema),
  nextCursor: z.string().nullable()
});
export type OrganizeRunsResponse = z.infer<typeof organizeRunsResponseSchema>;

/** `POST /run` returns 409 `{ error: "run_in_progress", runId }` while another run is active. */
export const organizeRunStartResponseSchema = z.object({
  run: organizeRunSummarySchema
});
export type OrganizeRunStartResponse = z.infer<typeof organizeRunStartResponseSchema>;

/** SSE: the `event:` field equals `type`, `data:` is the JSON-encoded event. */
export const organizeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), runId: z.string(), trigger: organizeTriggerSchema, scope: organizeScopeSchema.nullable(), total: count }),
  z.object({
    type: z.literal("run_progress"),
    runId: z.string(),
    stage: organizeStageSchema,
    done: count,
    total: count,
    currentItemId: z.string().nullable(),
    currentTitle: z.string().nullable()
  }),
  z.object({
    type: z.literal("item_done"),
    runId: z.string(),
    itemId: z.string(),
    status: organizeRunItemStatusSchema,
    decision: organizeDecisionSchema.nullable()
  }),
  z.object({ type: z.literal("run_paused"), runId: z.string(), reason: z.literal("daily_limit") }),
  z.object({ type: z.literal("run_finished"), runId: z.string(), status: organizeRunStatusSchema, stats: organizeRunStatsSchema }),
  z.object({ type: z.literal("run_failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("heartbeat"), at: z.string() })
]);
export type OrganizeEvent = z.infer<typeof organizeEventSchema>;
export type OrganizeEventType = OrganizeEvent["type"];

export const ORGANIZE_API = {
  settings: "/v1/organize/settings",
  preview: "/v1/organize/preview",
  run: "/v1/organize/run",
  runs: "/v1/organize/runs",
  runDetail: (id: string) => `/v1/organize/runs/${encodeURIComponent(id)}`,
  retry: (id: string) => `/v1/organize/runs/${encodeURIComponent(id)}/retry`,
  runTrace: (id: string) => `/v1/organize/runs/${encodeURIComponent(id)}/trace`,
  events: "/v1/organize/events"
} as const;
