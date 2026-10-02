import { z } from "zod";

export const SCHEMA_VERSION = 1;

/** Content events become inbox items or notes; the popup counts them as "knowledge". */
export const KNOWLEDGE_EVENT_TYPES = ["webpage_captured", "assistant_response_completed", "user_note"] as const;
/** Kept on the timeline and in reading statistics, counted separately in the popup. */
export const RECORD_EVENT_TYPES = ["user_message_sent", "reading_session_closed"] as const;
/** Activity tracking: metadata only, never page bodies; expires with the activity log retention. */
export const ACTIVITY_EVENT_TYPES = ["page_session", "search_performed", "selection", "copy", "activity_state"] as const;
/** Valid but never stored; the extension drops them before sending. */
export const IGNORED_EVENT_TYPES = ["page_opened", "source_excluded"] as const;

export const EVENT_TYPES = [...KNOWLEDGE_EVENT_TYPES, ...RECORD_EVENT_TYPES, ...ACTIVITY_EVENT_TYPES, ...IGNORED_EVENT_TYPES] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SOURCE_CHANNELS = ["browser_extension", "desktop_browser"] as const;
export const DOMAIN_CATEGORIES = ["learning_candidate", "unrelated", "neutral"] as const;
export const NAVIGATION_TRANSITIONS = ["link", "typed", "back_forward", "reload", "other"] as const;
export const ACTIVITY_STATES = ["idle", "active", "blur", "focus"] as const;

export const MAX_SNIPPET_CHARS = 500;
export const MAX_EXPOSURE_SECTIONS = 100;
export const MAX_EXPOSURE_TOP_BLOCKS = 10;

const text = z.string().regex(/\S/, "must not be empty");
const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date-time");
const seconds = z.number().finite().min(0);
const ratio = z.number().min(0).max(1);

export const eventSourceSchema = z.looseObject({
  channel: z.enum(SOURCE_CHANNELS),
  url: z.string().optional(),
  canonicalUrl: z.string().optional(),
  title: z.string().optional(),
  platform: z.string().optional(),
  isStrongLearning: z.boolean().optional()
});

const base = {
  id: z.string().regex(/^[\w-]{8,64}$/),
  schemaVersion: z.literal(SCHEMA_VERSION),
  occurredAt: isoDateTime,
  source: eventSourceSchema
};

const readingSignalsSchema = z.looseObject({
  activeDurationSeconds: seconds,
  maxScrollDepth: ratio.optional(),
  interactionCount: z.number().int().min(0).optional(),
  noteWritten: z.boolean().optional(),
  isStrongLearning: z.boolean().optional()
});

const richTextSchema = z.looseObject({
  plainText: text,
  markdown: z.string().optional(),
  sanitizedHtml: z.string().optional(),
  contentHash: z.string().optional()
});

export const exposureSchema = z.object({
  sections: z
    .array(
      z.object({
        key: text,
        heading: z.string().nullable(),
        chars: z.number().int().min(0),
        exposed_seconds: seconds,
        coverage: ratio
      })
    )
    .max(MAX_EXPOSURE_SECTIONS),
  top_blocks: z.array(z.object({ fp: text, exposed_seconds: seconds })).max(MAX_EXPOSURE_TOP_BLOCKS),
  page_coverage: ratio
});

const conversationFields = { conversationId: z.string().optional() };

export const pageOpenedEventSchema = z.looseObject({ ...base, type: z.literal("page_opened") });
export const sourceExcludedEventSchema = z.looseObject({ ...base, type: z.literal("source_excluded") });

export const webpageCapturedEventSchema = z.looseObject({
  ...base,
  type: z.literal("webpage_captured"),
  sessionId: z.string().optional(),
  reason: z.string().optional(),
  readingSignals: readingSignalsSchema.optional(),
  content: z.looseObject({
    plainText: text,
    canonicalUrl: text,
    title: z.string().optional(),
    markdown: z.string().optional(),
    sanitizedHtml: z.string().optional(),
    contentHash: z.string().optional(),
    extractor: z.string().optional(),
    media: z.array(z.unknown()).optional()
  })
});

export const readingSessionClosedEventSchema = z.looseObject({
  ...base,
  type: z.literal("reading_session_closed"),
  source: eventSourceSchema.extend({ canonicalUrl: text }),
  sessionId: z.string().optional(),
  readingSignals: readingSignalsSchema,
  openedAt: isoDateTime.optional(),
  captured: z.boolean().optional()
});

export const userMessageSentEventSchema = z.looseObject({
  ...base,
  ...conversationFields,
  type: z.literal("user_message_sent"),
  message: richTextSchema.extend({ role: z.string().optional() })
});

export const assistantResponseCompletedEventSchema = z.looseObject({
  ...base,
  ...conversationFields,
  type: z.literal("assistant_response_completed"),
  replyTo: z.string().optional(),
  question: z.looseObject({ id: z.string().optional(), plainText: z.string().optional(), occurredAt: isoDateTime.optional() }).optional(),
  answer: richTextSchema.extend({ role: z.string().optional() })
});

export const userNoteEventSchema = z.looseObject({
  ...base,
  type: z.literal("user_note"),
  note: z.looseObject({ text }),
  context: z.looseObject({ activeSourceUrl: z.string().optional() }).optional()
});

/**
 * One page visit. Pages in the `unrelated` category only report domain, category and duration:
 * URL, title and page text fields must be absent (privacy rule of 01).
 */
export const pageSessionEventSchema = z
  .looseObject({
    ...base,
    type: z.literal("page_session"),
    session: z.object({
      tabId: z.number().int().optional(),
      openerTabId: z.number().int().optional(),
      domain: text,
      category: z.enum(DOMAIN_CATEGORIES),
      url: z.string().optional(),
      title: z.string().optional(),
      h1: z.string().optional(),
      metaDescription: z.string().optional(),
      referrer: z.string().optional(),
      transition: z.enum(NAVIGATION_TRANSITIONS).optional(),
      startedAt: isoDateTime,
      endedAt: isoDateTime,
      visibleSeconds: seconds,
      maxScrollDepth: ratio.optional(),
      revisit: z.boolean().optional(),
      captured: z.boolean().optional(),
      exposure: exposureSchema.optional()
    })
  })
  .superRefine((event, ctx) => {
    if (event.session.category !== "unrelated") return;
    const leaked = (["url", "title", "h1", "metaDescription", "referrer", "exposure"] as const).filter((key) => event.session[key] !== undefined);
    if (event.source.url !== undefined) leaked.unshift("url");
    if (event.source.title !== undefined) leaked.unshift("title");
    for (const key of new Set(leaked)) ctx.addIssue({ code: "custom", path: ["session", key], message: "must be omitted for unrelated pages" });
  });

export const searchPerformedEventSchema = z.looseObject({
  ...base,
  type: z.literal("search_performed"),
  search: z.object({ engine: text, query: text, tabId: z.number().int().optional() })
});

const snippetSchema = z.object({ text: text.max(MAX_SNIPPET_CHARS), isCode: z.boolean() });
export const selectionEventSchema = z.looseObject({ ...base, type: z.literal("selection"), snippet: snippetSchema });
export const copyEventSchema = z.looseObject({ ...base, type: z.literal("copy"), snippet: snippetSchema });

export const activityStateEventSchema = z.looseObject({
  ...base,
  type: z.literal("activity_state"),
  state: z.enum(ACTIVITY_STATES)
});

export const EVENT_SCHEMAS = {
  page_opened: pageOpenedEventSchema,
  source_excluded: sourceExcludedEventSchema,
  webpage_captured: webpageCapturedEventSchema,
  reading_session_closed: readingSessionClosedEventSchema,
  user_message_sent: userMessageSentEventSchema,
  assistant_response_completed: assistantResponseCompletedEventSchema,
  user_note: userNoteEventSchema,
  page_session: pageSessionEventSchema,
  search_performed: searchPerformedEventSchema,
  selection: selectionEventSchema,
  copy: copyEventSchema,
  activity_state: activityStateEventSchema
} as const satisfies Record<EventType, z.ZodType>;

export const collectorEventSchema = z.discriminatedUnion("type", [
  pageOpenedEventSchema,
  sourceExcludedEventSchema,
  webpageCapturedEventSchema,
  readingSessionClosedEventSchema,
  userMessageSentEventSchema,
  assistantResponseCompletedEventSchema,
  userNoteEventSchema,
  pageSessionEventSchema,
  searchPerformedEventSchema,
  selectionEventSchema,
  copyEventSchema,
  activityStateEventSchema
]);

export type CollectorEvent = z.infer<typeof collectorEventSchema>;
export type EventOf<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
export type PageSessionEvent = EventOf<"page_session">;
export type Exposure = z.infer<typeof exposureSchema>;

export const isEventType = (value: unknown): value is EventType => typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);

/** Batch sync (01): at most 50 events or 2 MB per request, one result per event. */
export const MAX_BATCH_EVENTS = 50;
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;

export const eventBatchRequestSchema = z.object({ events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS) });

export const eventResultStatuses = ["accepted", "duplicate", "ignored", "rejected"] as const;
export const eventBatchResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().nullable(),
      status: z.enum(eventResultStatuses),
      error: z.string().optional()
    })
  )
});
export type EventBatchResult = z.infer<typeof eventBatchResultSchema>;
