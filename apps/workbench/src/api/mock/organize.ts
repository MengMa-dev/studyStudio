import {
  DEFAULT_ORGANIZE_SETTINGS,
  organizePreviewRequestSchema,
  organizePreviewResponseSchema,
  organizeRunDetailSchema,
  organizeRunRequestSchema,
  organizeRunsQuerySchema,
  organizeRunsResponseSchema,
  organizeRunStartResponseSchema,
  organizeRunTraceResponseSchema,
  organizeSettingsResponseSchema,
  organizeSettingsUpdateSchema,
  type Note,
  type OrganizeEvent,
  type OrganizePreviewRequestInput,
  type OrganizeRunDetail,
  type OrganizeRunRequest,
  type OrganizeRunRequestInput,
  type OrganizeRunsQuery,
  type OrganizeRunStats,
  type OrganizeScope,
  type OrganizeSettings,
  type OrganizeSettingsUpdate,
  type OrganizeStage,
  type OrganizeTraceStep,
  type OrganizeTrigger
} from "@study-studio/shared";

import { getMockState } from "./client";
import { mockIntegrateItem, mockKbDirtyCount, mockKbEntryIds, mockKbEntryName, mockKbEntryNotes, mockRewriteEntries } from "./kb";
import type { MockItem } from "./seed";

const MODEL = "gemini-3.8-flash";

function emptyStats(): OrganizeRunStats {
  return {
    episodes: { learning: 0, notLearning: 0, deferred: 0 },
    items: { total: 0, ingested: 0, rejected: 0, failed: 0, skipped: 0 },
    decisions: { new: 0, supplement: 0, duplicate: 0, reject: 0, notLearning: 0, prefiltered: 0 },
    kb: { entriesCreated: 0, relationsCreated: 0, entriesSupplemented: 0, entriesRewritten: 0 },
    stages: []
  };
}

function sampleTrace(): OrganizeTraceStep[] {
  const steps: Array<Omit<OrganizeTraceStep, "seq" | "createdAt" | "model" | "inputTokens" | "outputTokens" | "entryId"> & Partial<OrganizeTraceStep>> = [
    {
      stage: "context",
      step: "context",
      itemIds: ["item-p2", "item-q1", "item-p3", "item-p1"],
      episodeId: null,
      input: { trigger: "daily", is_manual: false, anchor_item_ids: ["item-p2", "item-q1", "item-p3", "item-p1"] },
      output: { learner_profile: { role: "算法工程师", learning_focus: [{ topic: "检索与重排" }] }, recent_kb_topics: ["重排", "向量检索"], timeline_units: 42, window_items: [] }
    },
    {
      stage: "episode",
      step: "episodes",
      itemIds: [],
      episodeId: null,
      input: { timeline_units: 42, is_manual: false },
      output: [
        {
          episode_id: "ep_a1",
          status: "ready",
          prefilter_reason: null,
          started_at: "2026-09-30T12:02:00.000Z",
          ended_at: "2026-09-30T12:48:00.000Z",
          active_seconds: 2280,
          flags: [],
          item_ids: ["item-p2", "item-q1"],
          anchor_item_ids: ["item-p2", "item-q1"],
          judge_input: { timeline: [{ t: "20:02", kind: "search", query: "cross encoder vs bi-encoder" }] }
        },
        {
          episode_id: "ep_b2",
          status: "ready",
          prefilter_reason: null,
          started_at: "2026-09-30T13:30:00.000Z",
          ended_at: "2026-09-30T13:41:00.000Z",
          active_seconds: 540,
          flags: [],
          item_ids: ["item-p3", "item-p1"],
          anchor_item_ids: ["item-p3", "item-p1"],
          judge_input: { timeline: [] }
        }
      ]
    },
    {
      stage: "learning_judge",
      step: "learning_judge",
      itemIds: ["item-p2", "item-q1"],
      episodeId: "ep_a1",
      model: MODEL,
      inputTokens: 1400,
      outputTokens: 200,
      input: { prompt_version: "learning_judge@2", input: { episode_id: "ep_a1" } },
      output: {
        is_learning: true,
        confidence: 0.92,
        topic: "重排模型",
        learning_goal: "理解交叉编码器与双塔模型的取舍",
        worth_extracting: true,
        candidate_item_ids: ["item-p2", "item-q1"],
        reason: "主动搜索并多轮追问"
      }
    },
    {
      stage: "learning_judge",
      step: "judge_verdict",
      itemIds: ["item-p2", "item-q1"],
      episodeId: "ep_a1",
      input: { is_learning: true, confidence: 0.92, worth_extracting: true, protected_item_ids: [] },
      output: {
        action: "proceed",
        episode_status: "learning",
        candidate_item_ids: ["item-p2", "item-q1"],
        rejected_item_ids: [],
        forced_item_ids: [],
        item_engagement: [{ item_id: "item-q1", engagement: "strong" }],
        reason: "主动搜索并多轮追问"
      }
    },
    {
      stage: "retrieve",
      step: "retrieve",
      itemIds: ["item-p3"],
      episodeId: "ep_b2",
      input: { path: "full", titles: ["IntersectionObserver - Web API | MDN"] },
      output: { candidates: [], prefilter: { route: "prefilter:low_info", decision: "reject", reject_reason: "low_information" } }
    },
    {
      stage: "retrieve",
      step: "retrieve",
      itemIds: ["item-p2"],
      episodeId: "ep_a1",
      input: { path: "full", titles: ["交叉编码器和双塔模型应该怎么选？"] },
      output: { candidates: [{ entry_id: "kb-rerank", name: "重排", similarity: 0.71, last_source_at: "2026-09-20" }], prefilter: { route: "llm" } }
    },
    {
      stage: "knowledge_processing",
      step: "knowledge_extract",
      itemIds: ["item-p2"],
      episodeId: "ep_a1",
      model: MODEL,
      inputTokens: 4100,
      outputTokens: 900,
      input: { prompt_version: "knowledge_extract@4", input: { step: "extract", instructions: [], feedback: null } },
      output: {
        fragments: [
          {
            concept: "交叉编码器",
            heading: "原理",
            markdown: "交叉编码器把 query 与文档拼接后整体编码……",
            summarized: false,
            source_section: "## 交叉编码器",
            turn_item_id: "item-p2"
          },
          {
            concept: "重排",
            heading: "双塔模型可离线预计算文档向量",
            markdown: "双塔模型把 query 与文档分别编码，文档向量可离线预计算……",
            summarized: false,
            source_section: "## 怎么选",
            turn_item_id: "item-p2"
          }
        ],
        removed: [{ source_section: null, reason: "boilerplate" }]
      }
    },
    {
      stage: "knowledge_processing",
      step: "knowledge_align",
      itemIds: ["item-p2"],
      episodeId: "ep_a1",
      model: MODEL,
      inputTokens: 2600,
      outputTokens: 420,
      input: { prompt_version: "knowledge_align@3", input: { step: "align", feedback: null } },
      output: {
        assignments: [
          { fragment_id: "f1", entry: "new:交叉编码器", covered_by: null },
          { fragment_id: "f2", entry: "kb-rerank", covered_by: null }
        ],
        new_entries: [{ key: "new:交叉编码器", name: "交叉编码器", aliases: ["Cross-encoder"], kind: "概念", category: "RAG", summary: "把 query 与文档拼接整体编码的重排模型" }],
        relations: [{ from: "交叉编码器", to: "重排", type: "part_of", description: null }]
      }
    },
    {
      stage: "knowledge_processing",
      step: "processing_result",
      itemIds: ["item-p2"],
      episodeId: "ep_a1",
      model: MODEL,
      input: { raw: { extract_retries: 0, missing_sections: [], rewritten_fragments: [], align_retries: 0 } },
      output: { output: { decision: "new", item_summary: "交叉编码器与双塔模型的取舍", item_points: ["交叉编码器精度高但无法预计算"] } }
    },
    {
      stage: "integration",
      step: "integration",
      itemIds: ["item-p2"],
      episodeId: "ep_a1",
      input: { decision: "new", reject_reason: null },
      output: {
        status: "ingested",
        entry_changes: [
          { entryId: "kb-cross", name: "交叉编码器", change: "created" },
          { entryId: "kb-rerank", name: "重排", change: "supplemented" }
        ],
        edges_created: 2
      }
    }
  ];
  return steps.map((step, index) => ({
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    entryId: null,
    createdAt: "2026-09-30T15:00:00.000Z",
    ...step,
    seq: index + 1
  }));
}

function createRuns(): OrganizeRunDetail[] {
  return [
    {
      id: "run-4",
      trigger: "manual",
      scope: "kb_selected",
      requirement: "重点突出和双塔模型的区别，多举例子",
      status: "completed",
      startedAt: "2026-10-02T01:12:00.000Z",
      finishedAt: "2026-10-02T01:13:41.000Z",
      tokens: 9_620,
      model: MODEL,
      stats: {
        ...emptyStats(),
        kb: { entriesCreated: 0, relationsCreated: 1, entriesSupplemented: 0, entriesRewritten: 2 },
        stages: [{ stage: "entry_rewrite", calls: 2, inputTokens: 7_900, outputTokens: 1_720 }]
      },
      progress: null,
      items: [],
      entries: [
        { entryId: "kb-rerank", name: "重排", change: "rewritten" },
        { entryId: "kb-bi", name: "双塔模型", change: "rewritten" }
      ],
      failures: []
    },
    {
      id: "run-3",
      trigger: "on_ingest",
      scope: null,
      requirement: null,
      status: "paused",
      startedAt: "2026-10-01T14:05:00.000Z",
      finishedAt: "2026-10-01T14:05:20.000Z",
      tokens: 1_210,
      model: MODEL,
      stats: {
        ...emptyStats(),
        items: { total: 1, ingested: 0, rejected: 0, failed: 0, skipped: 0 },
        stages: [{ stage: "learning_judge", calls: 1, inputTokens: 1_050, outputTokens: 160 }]
      },
      progress: { stage: "learning_judge", done: 0, total: 1 },
      items: [
        {
          itemId: "item-p5",
          title: "example/rag-toolkit：开箱即用的 RAG 工具集",
          type: "webpage",
          status: "pending",
          decision: null,
          route: null,
          entryIds: [],
          error: null
        }
      ],
      entries: [],
      failures: []
    },
    {
      id: "run-2",
      trigger: "batch",
      scope: null,
      requirement: null,
      status: "completed",
      startedAt: "2026-10-01T13:30:00.000Z",
      finishedAt: "2026-10-01T13:33:05.000Z",
      tokens: 12_880,
      model: MODEL,
      stats: {
        episodes: { learning: 2, notLearning: 0, deferred: 0 },
        items: { total: 3, ingested: 3, rejected: 0, failed: 0, skipped: 0 },
        decisions: { new: 2, supplement: 0, duplicate: 1, reject: 0, notLearning: 0, prefiltered: 0 },
        kb: { entriesCreated: 3, relationsCreated: 4, entriesSupplemented: 0, entriesRewritten: 0 },
        stages: [
          { stage: "learning_judge", calls: 2, inputTokens: 2_900, outputTokens: 410 },
          { stage: "knowledge_processing", calls: 3, inputTokens: 8_300, outputTokens: 1_270 }
        ]
      },
      progress: null,
      items: [
        {
          itemId: "item-q2",
          title: "向量召回和重排有什么区别？",
          type: "conversation",
          status: "ingested",
          decision: "new",
          route: "llm",
          entryIds: ["kb-hybrid", "kb-prompt-cache"],
          error: null
        },
        {
          itemId: "item-p4",
          title: "Okapi BM25 - 维基百科",
          type: "webpage",
          status: "ingested",
          decision: "new",
          route: "llm",
          entryIds: ["kb-bm25", "kb-rrf"],
          error: null
        },
        {
          itemId: "item-q1",
          title: "什么是交叉编码器？",
          type: "conversation",
          status: "ingested",
          decision: "duplicate",
          route: "prefilter:simhash",
          entryIds: ["kb-cross"],
          error: null
        }
      ],
      entries: [
        { entryId: "kb-hybrid", name: "混合检索", change: "created" },
        { entryId: "kb-bm25", name: "BM25", change: "created" },
        { entryId: "kb-rrf", name: "RRF 融合", change: "created" },
        { entryId: "kb-cross", name: "交叉编码器", change: "duplicate" }
      ],
      failures: []
    },
    {
      id: "run-1",
      trigger: "daily",
      scope: null,
      requirement: null,
      status: "completed",
      startedAt: "2026-09-30T15:00:00.000Z",
      finishedAt: "2026-09-30T15:04:12.000Z",
      tokens: 18_420,
      model: MODEL,
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
        {
          itemId: "item-p2",
          title: "交叉编码器和双塔模型应该怎么选？",
          type: "webpage",
          status: "ingested",
          decision: "new",
          route: "llm",
          entryIds: ["kb-cross"],
          error: null
        },
        {
          itemId: "item-q1",
          title: "什么是交叉编码器？",
          type: "conversation",
          status: "ingested",
          decision: "supplement",
          route: "llm",
          entryIds: ["kb-cross"],
          error: null
        },
        {
          itemId: "item-p3",
          title: "IntersectionObserver - Web API | MDN",
          type: "webpage",
          status: "rejected",
          decision: "reject",
          route: "prefilter:low_info",
          entryIds: [],
          error: null
        },
        {
          itemId: "item-p1",
          title: "从零实现 HNSW：分层可导航小世界图",
          type: "webpage",
          status: "failed",
          decision: null,
          route: "llm_long",
          entryIds: [],
          error: "context_length_exceeded"
        }
      ],
      entries: [
        { entryId: "kb-cross", name: "交叉编码器", change: "created" },
        { entryId: "kb-rerank", name: "重排", change: "supplemented" }
      ],
      failures: [{ jobId: "job-4", kind: "item", targetId: "item-p1", attempts: 3, error: "context_length_exceeded" }]
    }
  ];
}

let settings: OrganizeSettings = structuredClone(DEFAULT_ORGANIZE_SETTINGS);
let runs: OrganizeRunDetail[] = createRuns();
const listeners = new Set<(event: OrganizeEvent) => void>();
let tickMs = 650;
let activeTimer: ReturnType<typeof setTimeout> | null = null;
let idleWaiters: Array<() => void> = [];

export function resetMockOrganizeState(): void {
  if (activeTimer) clearTimeout(activeTimer);
  activeTimer = null;
  settings = structuredClone(DEFAULT_ORGANIZE_SETTINGS);
  runs = createRuns();
  flushIdle();
}

/** Delay between simulated progress steps (tests use 0). */
export function setMockOrganizeTickMs(ms: number): void {
  tickMs = ms;
}

/** Resolves once no simulated run is active. */
export function waitForMockOrganizeIdle(): Promise<void> {
  if (!activeRun()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function flushIdle(): void {
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

function emit(event: OrganizeEvent): void {
  for (const listener of listeners) listener(event);
}

function activeRun(): OrganizeRunDetail | undefined {
  return runs.find((run) => run.status === "running" || run.status === "queued");
}

function liveItems(): MockItem[] {
  return getMockState().items.filter((item) => !item.deletedAt);
}

function isPending(item: MockItem): boolean {
  return item.organizeStatus === "pending" || item.organizeStatus === "failed";
}

function fuzzyNotes(): Note[] {
  return getMockState().notes.filter((note) => note.scope === "fuzzy");
}

function settingsResponse() {
  const items = liveItems();
  return organizeSettingsResponseSchema.parse({
    settings,
    lastRunAt: runs.find((run) => run.finishedAt)?.finishedAt ?? null,
    nextRunAt: settings.autoEnabled && settings.triggers.daily.enabled ? `2026-10-03T${settings.triggers.daily.time}:00.000+08:00` : null,
    pendingCount: items.filter(isPending).length,
    dirtyCount: items.filter((item) => item.dirty).length + mockKbDirtyCount(),
    activeRunId: activeRun()?.id ?? null
  });
}

function summaryOf({ items: _items, entries: _entries, failures: _failures, ...summary }: OrganizeRunDetail) {
  return summary;
}

type Targets = { items: MockItem[]; entryIds: string[] };

function resolveTargets(scope: OrganizeScope, itemIds: string[], entryIds: string[]): Targets {
  const items = liveItems();
  switch (scope) {
    case "item":
    case "inbox_selected":
      return { items: items.filter((item) => itemIds.includes(item.id)), entryIds: [] };
    case "inbox_pending":
      return { items: items.filter((item) => isPending(item) || item.dirty), entryIds: [] };
    case "inbox_all":
      return { items, entryIds: [] };
    case "entry":
    case "kb_selected":
      return { items: [], entryIds: mockKbEntryIds().filter((id) => entryIds.includes(id)) };
    case "kb_pending":
      return { items: [], entryIds: mockKbEntryIds("pending") };
    case "kb_all":
      return { items: [], entryIds: mockKbEntryIds() };
  }
}

function itemNotes(items: MockItem[]): Note[] {
  const ids = new Set(items.map((item) => item.id));
  return getMockState().notes.filter((note) => note.scope === "item" && note.targetId !== null && ids.has(note.targetId));
}

function usesFuzzy(scope: OrganizeScope): boolean {
  return scope === "inbox_selected" || scope === "inbox_pending" || scope === "inbox_all";
}

function saveRequirement(body: OrganizeRunRequest): void {
  if (!body.requirement) return;
  const now = new Date().toISOString();
  const scope = body.scope === "item" ? "item" : body.scope === "entry" ? "entry" : "fuzzy";
  const targetId = scope === "item" ? (body.itemIds[0] ?? null) : scope === "entry" ? (body.entryIds[0] ?? null) : null;
  getMockState().notes.unshift({
    id: `note-req-${Date.now()}`,
    scope,
    targetId,
    text: body.requirement,
    origin: "organize_requirement",
    usedAt: null,
    createdAt: now,
    updatedAt: null
  });
}

type Step = { stage: OrganizeStage; title: string | null; itemId: string | null; apply: (run: OrganizeRunDetail) => void };

function addStage(stats: OrganizeRunStats, stage: OrganizeStage, inputTokens: number, outputTokens: number): void {
  const found = stats.stages.find((entry) => entry.stage === stage);
  if (found) {
    found.calls += 1;
    found.inputTokens += inputTokens;
    found.outputTokens += outputTokens;
  } else {
    stats.stages.push({ stage, calls: 1, inputTokens, outputTokens });
  }
}

function itemStep(item: MockItem): Step {
  return {
    stage: "knowledge_processing",
    title: item.title,
    itemId: item.id,
    apply: (run) => {
      const now = new Date().toISOString();
      const result = mockIntegrateItem(item, now);
      const ingested = result.decision !== "reject";
      item.organizeStatus = ingested ? "ingested" : "rejected";
      item.dirty = false;
      for (const note of itemNotes([item])) note.usedAt = now;
      run.items.push({
        itemId: item.id,
        title: item.title,
        type: item.type,
        status: ingested ? "ingested" : "rejected",
        decision: result.decision,
        route: result.decision === "reject" ? "prefilter:low_info" : "llm",
        entryIds: result.entries.map((change) => change.entryId),
        error: null
      });
      for (const change of result.entries) if (!run.entries.some((existing) => existing.entryId === change.entryId)) run.entries.push(change);
      const stats = run.stats;
      stats.items[ingested ? "ingested" : "rejected"] += 1;
      stats.decisions[result.decision] += 1;
      if (result.decision === "reject") stats.decisions.prefiltered += 1;
      else stats.episodes.learning += 1;
      stats.kb.entriesCreated += result.entries.filter((change) => change.change === "created").length;
      stats.kb.entriesSupplemented += result.entries.filter((change) => change.change === "supplemented").length;
      stats.kb.relationsCreated += result.entries.filter((change) => change.change === "created").length;
      addStage(stats, "learning_judge", 900, 140);
      if (result.decision !== "reject") addStage(stats, "knowledge_processing", 3_200, 520);
      run.tokens = stats.stages.reduce((sum, stage) => sum + stage.inputTokens + stage.outputTokens, 0);
      emit({ type: "item_done", runId: run.id, itemId: item.id, status: ingested ? "ingested" : "rejected", decision: result.decision });
    }
  };
}

function entryStep(entryId: string): Step {
  return {
    stage: "entry_rewrite",
    title: mockKbEntryName(entryId),
    itemId: null,
    apply: (run) => {
      const changes = mockRewriteEntries([entryId], new Date().toISOString());
      for (const change of changes) run.entries.push(change);
      run.stats.kb.entriesRewritten += changes.length;
      addStage(run.stats, "entry_rewrite", 3_600, 820);
      run.tokens = run.stats.stages.reduce((sum, stage) => sum + stage.inputTokens + stage.outputTokens, 0);
    }
  };
}

function startRun(
  trigger: OrganizeTrigger,
  scope: OrganizeScope | null,
  requirement: string | null,
  steps: Step[],
  onFinish?: (run: OrganizeRunDetail) => void
) {
  const total = steps.length;
  const run: OrganizeRunDetail = organizeRunDetailSchema.parse({
    id: `run-${Date.now()}`,
    trigger,
    scope,
    requirement,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tokens: 0,
    model: MODEL,
    stats: { ...emptyStats(), items: { ...emptyStats().items, total: steps.filter((step) => step.itemId).length } },
    progress: { stage: "context", done: 0, total },
    items: [],
    entries: [],
    failures: []
  });
  runs.unshift(run);
  emit({ type: "run_started", runId: run.id, trigger, scope, total });

  let index = 0;
  const tick = () => {
    const step = steps[index];
    if (!step) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.progress = null;
      onFinish?.(run);
      activeTimer = null;
      emit({ type: "run_finished", runId: run.id, status: run.status, stats: run.stats });
      flushIdle();
      return;
    }
    run.progress = { stage: step.stage, done: index, total };
    emit({ type: "run_progress", runId: run.id, stage: step.stage, done: index, total, currentItemId: step.itemId, currentTitle: step.title });
    step.apply(run);
    index += 1;
    run.progress = { stage: step.stage, done: index, total };
    emit({ type: "run_progress", runId: run.id, stage: step.stage, done: index, total, currentItemId: step.itemId, currentTitle: step.title });
    activeTimer = setTimeout(tick, tickMs);
  };
  activeTimer = setTimeout(tick, tickMs);
  return run;
}

function conflict(): never {
  const running = activeRun();
  throw new Error(`API 409: ${JSON.stringify({ error: "run_in_progress", runId: running?.id ?? null })}`);
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
    const targets = resolveTargets(body.scope, body.itemIds, body.entryIds);
    const notes = [...itemNotes(targets.items), ...mockKbEntryNotes(targets.entryIds)];
    const fuzzy = usesFuzzy(body.scope) ? fuzzyNotes() : [];
    return organizePreviewResponseSchema.parse({
      itemCount: targets.items.length,
      entryCount: targets.entryIds.length,
      newItemCount: targets.items.filter((item) => item.organizeStatus === "pending").length,
      editedItemCount: targets.items.filter((item) => item.dirty).length,
      noteCount: notes.length + fuzzy.length,
      newNoteCount: [...notes, ...fuzzy].filter((note) => !note.usedAt).length,
      fuzzyNoteCount: fuzzy.length,
      overDailyLimit: false
    });
  },

  async runOrganize(requestBody: OrganizeRunRequestInput) {
    const body = organizeRunRequestSchema.parse(requestBody);
    if (activeRun()) conflict();
    saveRequirement(body);
    const targets = resolveTargets(body.scope, body.itemIds, body.entryIds);
    const steps = [...targets.items.map((item) => itemStep(item)), ...targets.entryIds.map(entryStep)];
    const run = startRun("manual", body.scope, body.requirement ?? null, steps, () => {
      if (usesFuzzy(body.scope)) for (const note of fuzzyNotes()) note.usedAt ??= new Date().toISOString();
    });
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
    if (!run) throw new Error(`API 404: run not found: ${id}`);
    return organizeRunDetailSchema.parse(run);
  },

  async getOrganizeRunTrace(id: string) {
    if (!runs.some((candidate) => candidate.id === id)) throw new Error(`API 404: run not found: ${id}`);
    return organizeRunTraceResponseSchema.parse({ steps: id === "run-1" ? sampleTrace() : [] });
  },

  async retryOrganizeRun(id: string) {
    const source = runs.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`API 404: run not found: ${id}`);
    if (activeRun()) conflict();
    const failedIds = new Set(source.failures.map((failure) => failure.targetId).filter((target): target is string => Boolean(target)));
    const items = liveItems().filter((item) => failedIds.has(item.id));
    const run = startRun(
      "retry",
      source.scope,
      source.requirement,
      items.map((item) => itemStep(item)),
      () => {
        source.failures = [];
        source.items = source.items.map((item) => (failedIds.has(item.itemId) ? { ...item, status: "skipped", error: "已重试，见新记录" } : item));
      }
    );
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
