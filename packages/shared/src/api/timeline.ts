import { z } from "zod";

export const timelineRowTypeSchema = z.enum(["webpage", "conversation", "document", "fuzzy"]);
export type TimelineRowType = z.infer<typeof timelineRowTypeSchema>;

export const timelineRowSchema = z.object({
  id: z.string().min(1),
  type: timelineRowTypeSchema,
  startedAt: z.string(),
  title: z.string(),
  site: z.string().nullable(),
  itemId: z.string().nullable(),
  noteId: z.string().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  tags: z.array(z.string()).default([])
});
export type TimelineRow = z.infer<typeof timelineRowSchema>;

export const timelineDaySchema = z.object({
  day: z.string(),
  label: z.string(),
  minutes: z.number().int().nonnegative(),
  rows: z.array(timelineRowSchema)
});
export type TimelineDay = z.infer<typeof timelineDaySchema>;

export const timelineQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  types: z.string().optional()
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

export const timelineResponseSchema = z.object({
  days: z.array(timelineDaySchema)
});
export type TimelineResponse = z.infer<typeof timelineResponseSchema>;

export const overviewTodaySchema = z.object({
  minutes: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  qa: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative()
});
export type OverviewToday = z.infer<typeof overviewTodaySchema>;

export const overviewWeekDaySchema = z.object({
  day: z.string(),
  minutes: z.number().int().nonnegative()
});
export type OverviewWeekDay = z.infer<typeof overviewWeekDaySchema>;

export const overviewSourceSchema = z.object({
  name: z.string(),
  minutes: z.number().int().nonnegative()
});
export type OverviewSource = z.infer<typeof overviewSourceSchema>;

export const overviewPendingSchema = z.object({
  unread: z.number().int().nonnegative(),
  pendingOrganize: z.number().int().nonnegative(),
  weakEntries: z.number().int().nonnegative()
});
export type OverviewPending = z.infer<typeof overviewPendingSchema>;

export const overviewQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional()
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export const overviewResponseSchema = z.object({
  today: overviewTodaySchema,
  week: z.array(overviewWeekDaySchema),
  sources: z.array(overviewSourceSchema),
  pending: overviewPendingSchema
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

export const presenceResponseSchema = z.object({
  active: z.boolean(),
  title: z.string().nullable(),
  site: z.string().nullable(),
  url: z.string().nullable(),
  seconds: z.number().int().nonnegative().nullable(),
  captured: z.boolean().nullable(),
  updatedAt: z.string().nullable()
});
export type PresenceResponse = z.infer<typeof presenceResponseSchema>;

export const TIMELINE_API = {
  timeline: "/v1/workbench/timeline",
  overview: "/v1/workbench/overview",
  presence: "/v1/presence"
} as const;
