import {
  DEFAULT_ORGANIZE_SETTINGS,
  organizePreviewRequestSchema,
  organizePreviewResponseSchema,
  organizeRunDetailSchema,
  organizeRunRequestSchema,
  organizeRunsQuerySchema,
  organizeRunsResponseSchema,
  organizeRunStartResponseSchema,
  organizeSettingsResponseSchema,
  organizeSettingsUpdateSchema,
  type OrganizeEvent,
  type OrganizePreviewRequestInput,
  type OrganizeRunDetail,
  type OrganizeRunRequestInput,
  type OrganizeRunsQuery,
  type OrganizeRunStats,
  type OrganizeSettings,
  type OrganizeSettingsUpdate
} from "@study-studio/shared";

function emptyStats(): OrganizeRunStats {
  return {
    episodes: { learning: 0, notLearning: 0, deferred: 0 },
    items: { total: 0, ingested: 0, rejected: 0, failed: 0, skipped: 0 },
    decisions: { new: 0, supplement: 0, duplicate: 0, reject: 0, notLearning: 0, prefiltered: 0 },
    kb: { entriesCreated: 0, relationsCreated: 0, entriesSupplemented: 0, entriesRewritten: 0 },
    stages: []
  };
}

function createRuns(): OrganizeRunDetail[] {
  return [
    {
      id: "run-1",
      trigger: "daily",
      scope: null,
      requirement: null,
      status: "completed",
      startedAt: "2026-10-01T15:00:00.000Z",
      finishedAt: "2026-10-01T15:04:12.000Z",
      tokens: 18_420,
      model: "gemini-3.8-flash",
      stats: {
        episodes: { learning: 2, notLearning: 1, deferred: 0 },
        items: { total: 4, ingested: 2, rejected: 1, failed: 1, skipped: 0 },
        decisions: { new: 1, supplement: 1, duplicate: 0, reject: 1, notLearning: 0, prefiltered: 1 },
        kb: { entriesCreated: 1, relationsCreated: 2, entriesSupplemented: 1, entriesRewritten: 0 },
        stages: [
          { stage: "learning_judge", calls: 3, inputTokens: 4_200, outputTokens: 600 },
          { stage: "knowledge_processing", calls: 2, inputTokens: 11_800, outputTokens: 1_820 }
        ]
      },
      progress: null,
      items: [
        { itemId: "item-p2", title: "重排模型对比", type: "webpage", status: "ingested", decision: "new", route: "llm", entryIds: ["kb-cross"], error: null },
        {
          itemId: "item-q1",
          title: "交叉编码器为什么慢",
          type: "conversation",
          status: "ingested",
          decision: "supplement",
          route: "llm",
          entryIds: ["kb-cross"],
          error: null
        },
        {
          itemId: "item-p3",
          title: "导航页",
          type: "webpage",
          status: "rejected",
          decision: "reject",
          route: "prefilter:navigational",
          entryIds: [],
          error: null
        },
        { itemId: "item-p4", title: "超长文档", type: "webpage", status: "failed", decision: null, route: null, entryIds: [], error: "context_length_exceeded" }
      ],
      entries: [
        { entryId: "kb-cross", name: "交叉编码器", change: "created" },
        { entryId: "kb-rerank", name: "重排", change: "supplemented" }
      ],
      failures: [{ jobId: "job-4", kind: "item", targetId: "item-p4", attempts: 3, error: "context_length_exceeded" }]
    }
  ];
}

let settings: OrganizeSettings = structuredClone(DEFAULT_ORGANIZE_SETTINGS);
let runs: OrganizeRunDetail[] = createRuns();
const listeners = new Set<(event: OrganizeEvent) => void>();

export function resetMockOrganizeState(): void {
  settings = structuredClone(DEFAULT_ORGANIZE_SETTINGS);
  runs = createRuns();
}

function emit(event: OrganizeEvent): void {
  for (const listener of listeners) listener(event);
}

function settingsResponse() {
  return organizeSettingsResponseSchema.parse({
    settings,
    lastRunAt: runs[0]?.finishedAt ?? null,
    nextRunAt: settings.autoEnabled && settings.triggers.daily.enabled ? "2026-10-03T15:00:00.000Z" : null,
    pendingCount: 3,
    dirtyCount: 1,
    activeRunId: runs.find((run) => run.status === "running" || run.status === "queued")?.id ?? null
  });
}

function summaryOf({ items: _items, entries: _entries, failures: _failures, ...summary }: OrganizeRunDetail) {
  return summary;
}

export const mockOrganizeApi = {
  async getOrganizeSettings() {
    return settingsResponse();
  },

  async putOrganizeSettings(update: OrganizeSettingsUpdate) {
    const body = organizeSettingsUpdateSchema.parse(update);
    settings = {
      autoEnabled: body.autoEnabled ?? settings.autoEnabled,
      triggers: {
        daily: { ...settings.triggers.daily, ...body.triggers?.daily },
        batch: { ...settings.triggers.batch, ...body.triggers?.batch },
        onIngest: { ...settings.triggers.onIngest, ...body.triggers?.onIngest }
      },
      outputLanguage: body.outputLanguage ?? settings.outputLanguage
    };
    return settingsResponse();
  },

  async previewOrganize(requestBody: OrganizePreviewRequestInput) {
    const body = organizePreviewRequestSchema.parse(requestBody);
    const itemCount = body.scope.startsWith("inbox_") || body.scope === "item" ? Math.max(body.itemIds.length, body.scope === "inbox_selected" ? 0 : 3) : 0;
    const entryCount = body.scope.startsWith("kb_") || body.scope === "entry" ? Math.max(body.entryIds.length, body.scope === "kb_selected" ? 0 : 2) : 0;
    return organizePreviewResponseSchema.parse({
      itemCount,
      entryCount,
      newItemCount: itemCount,
      editedItemCount: 0,
      noteCount: 1,
      newNoteCount: 1,
      fuzzyNoteCount: 1,
      overDailyLimit: false
    });
  },

  async runOrganize(requestBody: OrganizeRunRequestInput) {
    const body = organizeRunRequestSchema.parse(requestBody);
    const total = body.itemIds.length + body.entryIds.length || 3;
    const run: OrganizeRunDetail = organizeRunDetailSchema.parse({
      id: `run-${Date.now()}`,
      trigger: "manual",
      scope: body.scope,
      requirement: body.requirement ?? null,
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      tokens: 0,
      model: "mock",
      stats: { ...emptyStats(), items: { total, ingested: total, rejected: 0, failed: 0, skipped: 0 } },
      progress: null,
      items: [],
      entries: [],
      failures: []
    });
    runs.unshift(run);
    emit({ type: "run_started", runId: run.id, trigger: run.trigger, scope: run.scope, total });
    emit({ type: "run_finished", runId: run.id, status: run.status, stats: run.stats });
    return organizeRunStartResponseSchema.parse({ run: summaryOf(run) });
  },

  async listOrganizeRuns(rawQuery: Partial<OrganizeRunsQuery> = {}) {
    const query = organizeRunsQuerySchema.parse(rawQuery);
    const start = query.cursor ? runs.findIndex((run) => run.id === query.cursor) + 1 : 0;
    const page = runs.slice(start, start + query.limit);
    const hasMore = start + query.limit < runs.length;
    return organizeRunsResponseSchema.parse({ runs: page.map(summaryOf), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null });
  },

  async getOrganizeRun(id: string) {
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return organizeRunDetailSchema.parse(run);
  },

  async retryOrganizeRun(id: string) {
    const source = runs.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Run not found: ${id}`);
    const run = organizeRunDetailSchema.parse({
      ...source,
      id: `run-${Date.now()}`,
      trigger: "retry",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stats: emptyStats(),
      items: [],
      entries: [],
      failures: []
    });
    runs.unshift(run);
    return organizeRunStartResponseSchema.parse({ run: summaryOf(run) });
  },

  /** Returns an unsubscribe function. */
  subscribeOrganizeEvents(onEvent: (event: OrganizeEvent) => void): () => void {
    listeners.add(onEvent);
    return () => {
      listeners.delete(onEvent);
    };
  }
};
