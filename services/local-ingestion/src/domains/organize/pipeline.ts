import type { DatabaseSync } from "node:sqlite";
import type { OrganizeDecision, OrganizeRunItemStatus, OrganizeRunStats, OrganizeStage } from "@study-studio/shared";
import type { LearningJudgeOutput } from "../../ai/prompts/schemas.draft.js";
import { commitUnit } from "./commit.js";
import type { EngagementLevel } from "./constants.js";
import { loadLearnerProfile, loadTimeline, toOrganizeProfile, type JudgeProfile } from "./context.js";
import { applySegmentSuggestion, buildEpisodes } from "./episode-builder.js";
import { computeInputHash } from "./hash.js";
import { integrateFragments, recordDuplicate, recordRejection, type IntegrationContext, type IntegrationResult, type ResultRecord } from "./integrate.js";
import {
  cachedJudgement,
  deterministicEpisodeId,
  judgeEpisode,
  JUDGE_PROMPT_VERSION,
  saveEpisode,
  toPromptJudgeInput,
  withEpisodeId,
  type EpisodeStatusValue
} from "./judge.js";
import { indexEntryBody, indexEntrySummary, vectorRecall, type IndexContext } from "./kb-index.js";
import { isUsageLimitError, tryEmbed, type LlmContext } from "./llm.js";
import { decideAfterLearningJudge, decideSegmentCorrection } from "./postprocess.js";
import { prefilterItem } from "./prefilter.js";
import { PROCESSING_PROMPT_VERSION, processUnit, type ProcessingContext, type WorkEpisode, type WorkUnit } from "./process.js";
import { FingerprintCache, RetrievalCache, retrieveCandidates, type EpisodeQuery } from "./retrieve.js";
import { rewriteEntry, staleEntryIds } from "./rewrite.js";
import { emptyStats, setJob, type JobStatus, type RunSpec } from "./run-store.js";
import { ENTRY_OWNER, UsageTracker, type OrganizeDeps } from "./runtime-types.js";
import { fuzzyNotesNear, kbIgnoreNames, listAliveEntries, loadEntry, loadItems, parseStringArray, recentKbTopics, type OrganizeItem } from "./store.js";
import { TraceRecorder } from "./trace.js";
import type { ActivityEpisode } from "./types.js";

/** Orchestrates ①–⑦ for one run. Work units run serially so each ④ sees the previous ⑥ writes. */

export type PipelineHooks = {
  onProgress?: (progress: { stage: OrganizeStage; done: number; total: number; currentItemId: string | null; currentTitle: string | null }) => void;
  onItemDone?: (event: { itemId: string; status: OrganizeRunItemStatus; decision: OrganizeDecision | null }) => void;
};

export type PipelineResult = {
  status: "completed" | "paused";
  stats: OrganizeRunStats;
  tokens: number;
  model: string | null;
};

export class OrganizeAbortedError extends Error {
  constructor() {
    super("organize run aborted");
    this.name = "OrganizeAbortedError";
  }
}

class PauseSignal extends Error {}

const AUTO_TRIGGERS = new Set(["daily", "batch", "on_ingest", "catch_up"]);
const ENGAGEMENT_RANK: Record<EngagementLevel, number> = { weak: 0, medium: 1, strong: 2 };

type Targets = {
  fullIds: string[];
  directIds: string[];
  rewriteIds: string[];
  rewriteTrigger: "manual" | "full";
};

function ids(db: DatabaseSync, sql: string, ...params: string[]): string[] {
  return (db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);
}

function restrict(list: string[], only: string[]): string[] {
  if (only.length === 0) return list;
  const allowed = new Set(only);
  return list.filter((id) => allowed.has(id));
}

export function resolveTargets(db: DatabaseSync, spec: RunSpec): Targets {
  const pending = () => ids(db, "SELECT id FROM items WHERE deleted_at IS NULL AND organize_status IN ('pending', 'failed') ORDER BY captured_at");
  const targets: Targets = { fullIds: [], directIds: [], rewriteIds: [], rewriteTrigger: "manual" };
  if (spec.trigger === "retry") {
    const alive = new Set(ids(db, "SELECT id FROM items WHERE deleted_at IS NULL"));
    targets.fullIds = [...new Set(spec.itemIds)].filter((id) => alive.has(id));
    targets.rewriteIds = [...new Set(spec.entryIds)];
    return targets;
  }
  switch (spec.scope) {
    case null:
      targets.fullIds = restrict(pending(), spec.itemIds);
      break;
    case "inbox_pending":
      targets.fullIds = restrict(pending(), spec.itemIds);
      targets.directIds = restrict(
        ids(db, "SELECT id FROM items WHERE deleted_at IS NULL AND dirty = 1 AND organize_status IN ('ingested', 'rejected') ORDER BY captured_at"),
        spec.itemIds
      );
      break;
    case "inbox_all":
      targets.fullIds = restrict(ids(db, "SELECT id FROM items WHERE deleted_at IS NULL ORDER BY captured_at"), spec.itemIds);
      if (spec.itemIds.length === 0) {
        targets.rewriteIds = ids(db, "SELECT id FROM kb_entries WHERE deleted_at IS NULL ORDER BY updated_at");
        targets.rewriteTrigger = "full";
      }
      break;
    case "inbox_selected":
    case "item":
      targets.directIds = [...new Set(spec.itemIds)];
      break;
    case "kb_selected":
    case "entry":
      targets.rewriteIds = [...new Set(spec.entryIds)];
      break;
    case "kb_pending":
      targets.rewriteIds = restrict(
        ids(db, "SELECT id FROM kb_entries WHERE deleted_at IS NULL AND (dirty = 1 OR stale = 1) ORDER BY updated_at"),
        spec.entryIds
      );
      break;
    case "kb_all":
      targets.rewriteIds = restrict(ids(db, "SELECT id FROM kb_entries WHERE deleted_at IS NULL ORDER BY updated_at"), spec.entryIds);
      targets.rewriteTrigger = "full";
      break;
  }
  const full = new Set(targets.fullIds);
  targets.directIds = targets.directIds.filter((id) => !full.has(id));
  return targets;
}

function maxEngagement(levels: EngagementLevel[]): EngagementLevel {
  return levels.reduce<EngagementLevel>((best, level) => (ENGAGEMENT_RANK[level] > ENGAGEMENT_RANK[best] ? level : best), "weak");
}

/** Groups conversation turns of the same thread into one unit (07 ⑤「问答的处理」). */
export function buildUnits(
  items: OrganizeItem[],
  engagementOf: (item: OrganizeItem) => EngagementLevel,
  episode: WorkEpisode | null,
  options: { path: WorkUnit["path"]; adoptOf: (item: OrganizeItem) => boolean }
): WorkUnit[] {
  const units: WorkUnit[] = [];
  const threads = new Map<string, OrganizeItem[]>();
  for (const item of [...items].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    if (item.type === "conversation" && item.conversationId) {
      const key = `${item.conversationId}\0${options.adoptOf(item)}`;
      const thread = threads.get(key);
      if (thread) {
        thread.push(item);
        continue;
      }
      const created = [item];
      threads.set(key, created);
      units.push({ key: item.id, items: created, episode, engagement: "weak", adopt: options.adoptOf(item), path: options.path });
      continue;
    }
    units.push({ key: item.id, items: [item], episode, engagement: "weak", adopt: options.adoptOf(item), path: options.path });
  }
  for (const unit of units) unit.engagement = maxEngagement(unit.items.map(engagementOf));
  return units;
}

type RunState = {
  deps: OrganizeDeps;
  runId: string;
  spec: RunSpec;
  now: Date;
  nowIso: string;
  llm: LlmContext;
  usage: UsageTracker;
  stats: OrganizeRunStats;
  hooks: PipelineHooks;
  done: number;
  total: number;
  bodyQueue: Set<string>;
  trace: TraceRecorder;
  signal?: AbortSignal;
};

function checkAbort(state: RunState): void {
  if (state.signal?.aborted) throw new OrganizeAbortedError();
}

function progress(state: RunState, stage: OrganizeStage, item: OrganizeItem | null): void {
  state.hooks.onProgress?.({ stage, done: state.done, total: state.total, currentItemId: item?.id ?? null, currentTitle: item?.title ?? null });
}

function finishItems(state: RunState, items: OrganizeItem[], status: JobStatus, decision: OrganizeDecision | null, error: string | null = null): void {
  for (const item of items) setJob(state.deps.db, state.runId, "item", item.id, status, error);
  countItems(state, items, status, decision);
}

function countItems(state: RunState, items: OrganizeItem[], status: JobStatus, decision: OrganizeDecision | null): void {
  for (const item of items) {
    state.done += 1;
    const eventStatus: OrganizeRunItemStatus = status === "deferred" ? "pending" : (status as OrganizeRunItemStatus);
    state.hooks.onItemDone?.({ itemId: item.id, status: eventStatus, decision });
    if (status === "ingested") state.stats.items.ingested += 1;
    else if (status === "rejected") state.stats.items.rejected += 1;
    else if (status === "failed") state.stats.items.failed += 1;
    else if (status === "skipped") state.stats.items.skipped += 1;
  }
}

function failItems(state: RunState, items: OrganizeItem[], error: unknown): void {
  if (isUsageLimitError(error)) throw new PauseSignal();
  if (error instanceof OrganizeAbortedError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const update = state.deps.db.prepare("UPDATE items SET organize_status = 'failed' WHERE id = ?");
  for (const item of items) update.run(item.id);
  finishItems(state, items, "failed", null, message.slice(0, 1000));
}

function integrationContext(
  state: RunState,
  usedNoteIds: string[],
  nameSimilarities = new Map<string, Array<{ entry_id: string; similarity: number }>>()
): IntegrationContext {
  return { db: state.deps.db, runId: state.runId, now: state.nowIso, kbIgnore: kbIgnoreNames(state.deps.db), nameSimilarities, usedNoteIds };
}

function baseRecord(partial: Partial<ResultRecord> & Pick<ResultRecord, "decision" | "route">): ResultRecord {
  return {
    valueScore: null,
    rejectReason: null,
    reason: null,
    summary: null,
    points: null,
    model: null,
    promptVersion: null,
    inputHash: null,
    episodeId: null,
    override: null,
    output: null,
    ...partial
  };
}

// ③ ---------------------------------------------------------------------------------------------

type JudgedEpisode = { episode: ActivityEpisode; judgement: LearningJudgeOutput };

async function judgeWithCache(state: RunState, episode: ActivityEpisode, profile: JudgeProfile, topics: string[]): Promise<LearningJudgeOutput> {
  const cached = cachedJudgement(state.deps.db, episode.episodeId);
  if (cached) {
    state.trace.record("learning_judge", "judge_cached", { episode_id: episode.episodeId }, cached, { scope: { episodeId: episode.episodeId } });
    return cached;
  }
  return judgeEpisode(state.llm, toPromptJudgeInput(episode.judgeInput, profile, topics));
}

function rebuild(
  state: RunState,
  part: ActivityEpisode,
  profile: JudgeProfile,
  topics: string[],
  items: Parameters<typeof buildEpisodes>[0]["items"]
): ActivityEpisode[] {
  const built = buildEpisodes({ units: part.units, items, learnerProfile: toOrganizeProfile(profile), recentKbTopics: topics, now: state.now, isManual: true });
  return built.episodes.map((episode) => withEpisodeId(episode, deterministicEpisodeId(episode.judgeInput)));
}

/** Judge an episode; apply `segment_suggestion` at most once and re-judge the corrected pieces. */
async function judgeEpisodeTree(
  state: RunState,
  episode: ActivityEpisode,
  profile: JudgeProfile,
  topics: string[],
  items: Parameters<typeof buildEpisodes>[0]["items"]
): Promise<JudgedEpisode[]> {
  const judgement = await judgeWithCache(state, episode, profile, topics);
  const suggestion = judgement.segment_suggestion;
  const correction = decideSegmentCorrection(
    { action: suggestion.action, at: suggestion.at ?? undefined, with_episode_id: suggestion.with_episode_id ?? undefined },
    false
  );
  if (!correction.shouldApply || suggestion.action !== "split") return [{ episode, judgement }];
  const applied = applySegmentSuggestion([episode], episode.episodeId, { action: "split", at: suggestion.at ?? undefined }, false);
  if (!applied.applied) return [{ episode, judgement }];
  const pieces = applied.episodes.flatMap((part) => rebuild(state, part, profile, topics, items));
  if (pieces.length < 2) return [{ episode, judgement }];
  const out: JudgedEpisode[] = [];
  for (const piece of pieces) out.push({ episode: piece, judgement: await judgeWithCache(state, piece, profile, topics) });
  return out;
}

// Full path: ①②③ → units --------------------------------------------------------------------

async function planFullPath(state: RunState, anchors: OrganizeItem[]): Promise<WorkUnit[]> {
  if (anchors.length === 0) return [];
  const db = state.deps.db;
  progress(state, "context", anchors[0] ?? null);
  const profile = loadLearnerProfile(db, state.now);
  const topics = recentKbTopics(db, state.now);
  const timeline = loadTimeline(db, anchors);
  const isManual = !AUTO_TRIGGERS.has(state.spec.trigger);
  state.trace.setScope({ itemIds: anchors.map((item) => item.id) });
  state.trace.record(
    "context",
    "context",
    { trigger: state.spec.trigger, is_manual: isManual, anchor_item_ids: anchors.map((item) => item.id) },
    {
      learner_profile: profile,
      recent_kb_topics: topics,
      timeline_units: timeline.units.length,
      window_items: timeline.items.map((item) => ({ id: item.id, type: item.type, title: item.title ?? null, captured_at: item.capturedAt }))
    }
  );

  progress(state, "episode", null);
  const built = buildEpisodes({
    units: timeline.units,
    items: timeline.items,
    learnerProfile: toOrganizeProfile(profile),
    recentKbTopics: topics,
    now: state.now,
    isManual
  });
  const episodes = built.episodes.map((episode) => withEpisodeId(episode, deterministicEpisodeId(episode.judgeInput)));
  const anchorById = new Map(anchors.map((item) => [item.id, item]));
  state.trace.record(
    "episode",
    "episodes",
    { timeline_units: timeline.units.length, is_manual: isManual },
    episodes.map((episode) => ({
      episode_id: episode.episodeId,
      status: episode.status,
      prefilter_reason: episode.prefilterReason ?? null,
      started_at: episode.startedAt,
      ended_at: episode.endedAt,
      active_seconds: Math.round(episode.activeSeconds),
      flags: episode.flags,
      item_ids: episode.itemIds,
      anchor_item_ids: episode.itemIds.filter((id) => anchorById.has(id)),
      judge_input: episode.judgeInput
    }))
  );
  const assigned = new Set<string>();
  const units: WorkUnit[] = [];

  const reject = (items: OrganizeItem[], episodeId: string | null, reason: string | null, rejectReason: string | null) => {
    if (items.length === 0) return;
    const record = baseRecord({ decision: "not_learning", route: "judge", episodeId, reason, rejectReason, promptVersion: JUDGE_PROMPT_VERSION });
    recordRejection(integrationContext(state, []), items, record);
    state.stats.decisions.notLearning += items.length;
    finishItems(state, items, "rejected", "not_learning");
  };

  const record = (episode: ActivityEpisode, status: EpisodeStatusValue, judgement: LearningJudgeOutput | null, anchorIds: string[]) => {
    saveEpisode(db, episode, status, judgement, state.runId, anchorIds, state.nowIso);
    if (status === "learning") state.stats.episodes.learning += 1;
    else if (status === "not_learning") state.stats.episodes.notLearning += 1;
    else state.stats.episodes.deferred += 1;
  };

  for (const episode of episodes) {
    checkAbort(state);
    const episodeAnchors = episode.itemIds.filter((id) => anchorById.has(id) && !assigned.has(id)).map((id) => anchorById.get(id)!);
    if (episodeAnchors.length === 0) continue;
    for (const item of episodeAnchors) assigned.add(item.id);
    const protectedIds = episodeAnchors.filter((item) => item.itemNotes.length > 0 || item.highlights.length > 0).map((item) => item.id);

    if (episode.status === "open") {
      record(
        episode,
        "deferred",
        null,
        episodeAnchors.map((item) => item.id)
      );
      finishItems(state, episodeAnchors, "deferred", null);
      continue;
    }
    if (episode.status === "prefiltered") {
      record(
        episode,
        "not_learning",
        null,
        episodeAnchors.map((item) => item.id)
      );
      const forced = episodeAnchors.filter((item) => protectedIds.includes(item.id));
      reject(
        episodeAnchors.filter((item) => !protectedIds.includes(item.id)),
        episode.episodeId,
        `prefilter:${episode.prefilterReason ?? "rule"}`,
        null
      );
      units.push(...buildUnits(forced, () => "strong", null, { path: "full", adoptOf: () => false }));
      continue;
    }

    progress(state, "learning_judge", episodeAnchors[0] ?? null);
    state.trace.setScope({ itemIds: episodeAnchors.map((item) => item.id), episodeId: episode.episodeId });
    let judged: JudgedEpisode[];
    try {
      judged = await judgeEpisodeTree(state, episode, profile, topics, timeline.items);
    } catch (error) {
      failItems(state, episodeAnchors, error);
      continue;
    }

    const covered = new Set<string>();
    for (const { episode: piece, judgement } of judged) {
      const pieceAnchors = episodeAnchors.filter((item) => piece.itemIds.includes(item.id) && !covered.has(item.id));
      for (const item of pieceAnchors) covered.add(item.id);
      if (pieceAnchors.length === 0) continue;
      const pieceIds = pieceAnchors.map((item) => item.id);
      const verdict = decideAfterLearningJudge({
        is_learning: judgement.is_learning,
        confidence: judgement.confidence,
        worth_extracting: judgement.worth_extracting,
        candidate_item_ids: judgement.candidate_item_ids,
        protected_item_ids: protectedIds.filter((id) => pieceIds.includes(id))
      });
      const isLearningEpisode = verdict.action !== "reject_episode" && judgement.is_learning && judgement.worth_extracting && judgement.confidence >= 0.4;
      record(piece, isLearningEpisode ? "learning" : "not_learning", judgement, pieceIds);
      const candidateIds = new Set(
        verdict.action === "reject_episode" ? [] : [...(isLearningEpisode ? judgement.candidate_item_ids : []), ...verdict.force_include_item_ids]
      );
      state.trace.record(
        "learning_judge",
        "judge_verdict",
        { is_learning: judgement.is_learning, confidence: judgement.confidence, worth_extracting: judgement.worth_extracting, protected_item_ids: protectedIds },
        {
          action: verdict.action,
          episode_status: isLearningEpisode ? "learning" : "not_learning",
          candidate_item_ids: pieceIds.filter((id) => candidateIds.has(id)),
          rejected_item_ids: pieceIds.filter((id) => !candidateIds.has(id)),
          forced_item_ids: verdict.force_include_item_ids,
          item_engagement: judgement.item_engagement,
          reason: judgement.reason
        },
        { scope: { itemIds: pieceIds, episodeId: piece.episodeId } }
      );
      if (verdict.action === "reject_episode") {
        reject(pieceAnchors, piece.episodeId, judgement.reason, null);
        continue;
      }
      const candidates = pieceAnchors.filter((item) => candidateIds.has(item.id));
      reject(
        pieceAnchors.filter((item) => !candidateIds.has(item.id)),
        piece.episodeId,
        judgement.reason,
        isLearningEpisode ? "off_topic" : null
      );
      const engagement = new Map(judgement.item_engagement.map((entry) => [entry.item_id, entry.engagement]));
      const forced = new Set(verdict.force_include_item_ids);
      const workEpisode: WorkEpisode = {
        episodeId: piece.episodeId,
        topic: judgement.topic,
        learningGoal: judgement.learning_goal,
        relatedExploration: judgement.related_exploration,
        uncertain: verdict.action === "proceed_uncertain"
      };
      units.push(
        ...buildUnits(candidates, (item) => (forced.has(item.id) ? "strong" : (engagement.get(item.id) ?? "weak")), workEpisode, {
          path: "full",
          adoptOf: () => false
        })
      );
    }
    const leftovers = episodeAnchors.filter((item) => !covered.has(item.id));
    reject(leftovers, episode.episodeId, "not covered after segment correction", null);
  }

  const unassigned = anchors.filter((item) => !assigned.has(item.id));
  units.push(...buildUnits(unassigned, () => "medium", null, { path: "full", adoptOf: () => false }));
  return units;
}

// ④⑤⑥ per unit -----------------------------------------------------------------------------

function unitHash(unit: WorkUnit, notes: string[], requirement: string | null): string {
  return computeInputHash({
    content: unit.items.map((item) => `${item.question ?? ""}\n${item.body}`).join("\n\n"),
    notes: [...notes, ...(requirement ? [requirement] : [])],
    judge_result: {
      path: unit.path,
      adopt: unit.adopt,
      engagement: unit.engagement,
      topic: unit.episode?.topic ?? null,
      learning_goal: unit.episode?.learningGoal ?? null,
      uncertain: unit.episode?.uncertain ?? false
    },
    prompt_version: PROCESSING_PROMPT_VERSION
  });
}

/** Skips a unit whose stored `input_hash` matches and whose written entries still exist; restores the previous inbox status. */
function trySkip(state: RunState, unit: WorkUnit, hash: string): boolean {
  const db = state.deps.db;
  const select = db.prepare("SELECT input_hash, decision, target_entry_ids FROM organize_results WHERE item_id = ?");
  const alive = db.prepare("SELECT 1 FROM kb_entries WHERE id = ? AND deleted_at IS NULL");
  const previous = unit.items.map((item) => ({
    item,
    row: select.get(item.id) as { input_hash: string | null; decision: string | null; target_entry_ids: string | null } | undefined
  }));
  const entriesAlive = (ids: string | null) => parseStringArray(ids).every((id) => alive.get(id));
  if (!previous.every(({ item, row }) => row?.input_hash === hash && row.decision && !item.dirty && entriesAlive(row.target_entry_ids))) return false;
  const update = db.prepare("UPDATE items SET organize_status = ? WHERE id = ?");
  for (const { item, row } of previous) update.run(row!.decision === "reject" || row!.decision === "not_learning" ? "rejected" : "ingested", item.id);
  finishItems(state, unit.items, "skipped", null);
  return true;
}

async function nameSimilarities(
  state: RunState,
  indexCtx: IndexContext,
  names: string[]
): Promise<Map<string, Array<{ entry_id: string; similarity: number }>>> {
  const out = new Map<string, Array<{ entry_id: string; similarity: number }>>();
  if (!state.deps.searchIndex) return out;
  for (const name of names) {
    const vector = await tryEmbed(state.llm, name);
    if (!vector) continue;
    out.set(
      name,
      [...vectorRecall(indexCtx, vector, [ENTRY_OWNER.name], 10)].map(([entry_id, similarity]) => ({ entry_id, similarity }))
    );
  }
  return out;
}

function traceIntegration(state: RunState, decision: OrganizeDecision, status: JobStatus, result: IntegrationResult | null, rejectReason?: string | null): void {
  state.trace.record(
    "integration",
    "integration",
    { decision, reject_reason: rejectReason ?? null },
    { status, entry_changes: result?.entryChanges ?? [], edges_created: result?.edgesCreated ?? 0 }
  );
}

async function afterIntegration(
  state: RunState,
  indexCtx: IndexContext,
  fingerprints: FingerprintCache,
  unit: WorkUnit,
  result: IntegrationResult,
  status: JobStatus,
  decision: OrganizeDecision
): Promise<void> {
  traceIntegration(state, decision, status, result);
  for (const change of result.entryChanges) {
    fingerprints.add(change.entryId, unit.items[0]!);
    if (change.change === "created") state.stats.kb.entriesCreated += 1;
    if (change.change === "supplemented") state.stats.kb.entriesSupplemented += 1;
  }
  state.stats.kb.relationsCreated += result.edgesCreated;
  progress(state, "embedding", unit.items[0] ?? null);
  const indexed = await commitUnit({ db: state.deps.db, indexCtx, runId: state.runId }, unit.items, result, status);
  for (const entryId of indexed) state.bodyQueue.add(entryId);
  countItems(state, unit.items, status, decision);
}

async function runUnit(
  state: RunState,
  unit: WorkUnit,
  shared: { indexCtx: IndexContext; retrieval: RetrievalCache; fingerprints: FingerprintCache; ignore: string[] }
) {
  const db = state.deps.db;
  const anchor = unit.items[0]!;
  const fuzzy = fuzzyNotesNear(db, anchor.capturedAt);
  const itemNoteTexts = unit.items.flatMap((item) => item.itemNotes.map((note) => note.text));
  const usedNoteIds = [...unit.items.flatMap((item) => item.itemNotes.map((note) => note.id)), ...fuzzy.map((note) => note.id)];
  const hash = unitHash(unit, [...itemNoteTexts, ...fuzzy.map((note) => note.text)], state.spec.requirement);
  state.trace.setScope({ itemIds: unit.items.map((item) => item.id), episodeId: unit.episode?.episodeId ?? null });
  if (trySkip(state, unit, hash)) {
    state.trace.record("integration", "skipped", { input_hash: hash }, { reason: "input_hash 未变化，沿用上次整理结果" });
    return;
  }

  const common = { inputHash: hash, episodeId: unit.episode?.episodeId ?? null, override: unit.adopt ? ("adopt" as const) : null };
  progress(state, "retrieve", anchor);
  const entries = listAliveEntries(db);
  const episodeQuery: EpisodeQuery | null = unit.episode
    ? { key: unit.episode.episodeId, topic: unit.episode.topic, learningGoal: unit.episode.learningGoal, relatedExploration: unit.episode.relatedExploration }
    : null;
  const candidates = await retrieveCandidates(shared.indexCtx, shared.retrieval, unit.items, episodeQuery, entries, state.now);
  const body = unit.items.map((item) => item.body).join("\n\n");
  const prefilter = prefilterItem({
    item: {
      item_id: anchor.id,
      title: anchor.title,
      topic: unit.episode?.topic ?? null,
      url: anchor.type === "conversation" ? null : anchor.url,
      content_hash: unit.items.length === 1 ? anchor.contentHash : null,
      plain_text: body,
      markdown: body,
      has_note: itemNoteTexts.length > 0,
      has_highlight: unit.items.some((item) => item.highlights.length > 0)
    },
    related_candidates: candidates,
    source_fingerprints: shared.fingerprints.list(unit.items.map((item) => item.id)),
    kb_ignore_names: shared.ignore,
    now: state.now
  });
  state.trace.record(
    "retrieve",
    "retrieve",
    {
      path: unit.path,
      adopt: unit.adopt,
      engagement: unit.engagement,
      titles: unit.items.map((item) => item.title),
      episode_query: episodeQuery,
      has_note: itemNoteTexts.length > 0,
      has_highlight: unit.items.some((item) => item.highlights.length > 0)
    },
    { candidates: candidates.map(({ entry_id, name, similarity, last_source_at }) => ({ entry_id, name, similarity, last_source_at })), prefilter }
  );

  if (prefilter.route !== "llm" && !(unit.adopt && prefilter.decision === "reject")) {
    progress(state, "integration", anchor);
    if (prefilter.decision === "reject") {
      recordRejection(
        integrationContext(state, usedNoteIds),
        unit.items,
        baseRecord({ ...common, decision: "reject", route: prefilter.route, rejectReason: prefilter.reject_reason, output: { prefilter } })
      );
      traceIntegration(state, "reject", "rejected", null, prefilter.reject_reason);
      state.stats.decisions.prefiltered += 1;
      finishItems(state, unit.items, "rejected", "reject");
      return;
    }
    const quote = anchor.highlights.join("\n") || prefilter.evidence?.excerpt || anchor.title;
    const result = recordDuplicate(
      integrationContext(state, usedNoteIds),
      unit.items,
      prefilter.target_entry_ids.map((entryId) => ({ entryId, evidence: [{ quote }] })),
      baseRecord({ ...common, decision: "duplicate", route: prefilter.route, output: { prefilter } })
    );
    await afterIntegration(state, shared.indexCtx, shared.fingerprints, unit, result, "ingested", "duplicate");
    state.stats.decisions.prefiltered += 1;
    return;
  }

  progress(state, "knowledge_processing", anchor);
  const processing: ProcessingContext = {
    db,
    llm: state.llm,
    indexCtx: state.deps.searchIndex ? shared.indexCtx : null,
    requirement: state.spec.requirement,
    fuzzyNotes: fuzzy.map((note) => note.text),
    ignoredNames: shared.ignore
  };
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const outcome = await processUnit(processing, unit, prefilter.related_entries, entriesById);
  const output = outcome.output;
  state.trace.record("knowledge_processing", "processing_result", { raw: outcome.raw }, { output }, { model: outcome.model });
  const recordFields = {
    ...common,
    route: outcome.route,
    model: outcome.model,
    promptVersion: PROCESSING_PROMPT_VERSION,
    output: { raw: outcome.raw }
  };

  progress(state, "integration", anchor);
  if (output.decision === "reject") {
    recordRejection(
      integrationContext(state, usedNoteIds),
      unit.items,
      baseRecord({ ...recordFields, decision: "reject", rejectReason: output.reject_reason })
    );
    traceIntegration(state, "reject", "rejected", null, output.reject_reason);
    state.stats.decisions.reject += 1;
    finishItems(state, unit.items, "rejected", "reject");
    return;
  }
  const usedKeys = new Set(output.fragments.map((fragment) => fragment.entry));
  const newNames = output.new_entries.filter((entry) => usedKeys.has(entry.key)).map((entry) => entry.name);
  const similarities = await nameSimilarities(state, shared.indexCtx, newNames);
  const result = integrateFragments(
    integrationContext(state, usedNoteIds, similarities),
    unit.items,
    output,
    baseRecord({ ...recordFields, decision: output.decision, summary: output.item_summary, points: output.item_points })
  );
  if (result.status === "rejected") {
    await afterIntegration(state, shared.indexCtx, shared.fingerprints, unit, result, "rejected", "reject");
    state.stats.decisions.reject += 1;
    return;
  }
  await afterIntegration(state, shared.indexCtx, shared.fingerprints, unit, result, "ingested", output.decision);
  state.stats.decisions[output.decision] += 1;
}

// ⑦ ---------------------------------------------------------------------------------------------

async function runRewrites(state: RunState, indexCtx: IndexContext, explicit: string[], trigger: "manual" | "full"): Promise<void> {
  const db = state.deps.db;
  const stale = staleEntryIds(db).filter((id) => !explicit.includes(id));
  const jobs = [...explicit.map((id) => ({ id, trigger })), ...stale.map((id) => ({ id, trigger: "stale" as const }))];
  state.total += jobs.length;
  const requirement = state.spec.scope?.startsWith("kb_") || state.spec.scope === "entry" ? state.spec.requirement : null;
  for (const job of jobs) {
    checkAbort(state);
    progress(state, "entry_rewrite", null);
    state.trace.setScope({ entryId: job.id });
    try {
      const outcome = await rewriteEntry(db, state.llm, job.id, job.trigger, requirement, state.nowIso);
      setJob(db, state.runId, "entry_rewrite", job.id, outcome.status === "rewritten" ? "rewritten" : "skipped");
      if (outcome.status === "rewritten" && outcome.entry) {
        state.stats.kb.entriesRewritten += 1;
        await indexEntrySummary(indexCtx, outcome.entry);
        state.bodyQueue.add(job.id);
      }
    } catch (error) {
      if (isUsageLimitError(error)) throw new PauseSignal();
      if (error instanceof OrganizeAbortedError) throw error;
      setJob(db, state.runId, "entry_rewrite", job.id, "failed", error instanceof Error ? error.message.slice(0, 1000) : String(error));
    }
    state.done += 1;
  }
}

async function flushBodyIndex(state: RunState, indexCtx: IndexContext): Promise<void> {
  if (!state.deps.searchIndex || state.bodyQueue.size === 0) return;
  progress(state, "embedding", null);
  for (const entryId of state.bodyQueue) {
    const entry = loadEntry(state.deps.db, entryId);
    if (entry) await indexEntryBody(indexCtx, entry);
  }
  state.bodyQueue.clear();
}

function markRequirementUsed(db: DatabaseSync, requirement: string | null, now: string): void {
  if (!requirement) return;
  db.prepare("UPDATE notes SET used_at = ? WHERE origin = 'organize_requirement' AND text = ? AND used_at IS NULL").run(now, requirement);
}

export async function executeRun(deps: OrganizeDeps, runId: string, spec: RunSpec, hooks: PipelineHooks = {}, signal?: AbortSignal): Promise<PipelineResult> {
  if (!deps.gateway) throw new Error("ai_gateway_unavailable: 未配置 AI 服务商，无法整理");
  const now = deps.now?.() ?? new Date();
  const usage = new UsageTracker();
  const db = deps.db;
  const trace = new TraceRecorder(db, runId);
  const llm: LlmContext = { gateway: deps.gateway, usage, allowOverLimit: spec.allowOverLimit, signal, trace };
  const targets = resolveTargets(db, spec);
  const items = loadItems(db, [...targets.fullIds, ...targets.directIds]);
  const fullItems = targets.fullIds.map((id) => items.get(id)).filter((item): item is OrganizeItem => Boolean(item));
  const directItems = targets.directIds.map((id) => items.get(id)).filter((item): item is OrganizeItem => Boolean(item));

  const state: RunState = {
    deps,
    runId,
    spec,
    now,
    nowIso: now.toISOString(),
    llm,
    usage,
    stats: emptyStats(),
    hooks,
    done: 0,
    total: fullItems.length + directItems.length,
    bodyQueue: new Set(),
    signal,
    trace
  };
  state.stats.items.total = state.total;
  for (const item of [...fullItems, ...directItems]) setJob(db, runId, "item", item.id, "pending");

  const indexCtx: IndexContext = { db, searchIndex: deps.searchIndex, llm };
  const shared = { indexCtx, retrieval: new RetrievalCache(), fingerprints: new FingerprintCache(db), ignore: kbIgnoreNames(db) };
  let status: PipelineResult["status"] = "completed";
  try {
    const units = await planFullPath(state, fullItems);
    units.push(...buildUnits(directItems, () => "strong", null, { path: "direct", adoptOf: (item) => item.status === "rejected" }));
    for (const unit of units) {
      checkAbort(state);
      try {
        await runUnit(state, unit, shared);
      } catch (error) {
        failItems(state, unit.items, error);
      }
    }
    await runRewrites(state, indexCtx, targets.rewriteIds, targets.rewriteTrigger);
    markRequirementUsed(db, spec.requirement, state.nowIso);
  } catch (error) {
    if (!(error instanceof PauseSignal)) throw error;
    status = "paused";
  } finally {
    state.stats.stages = usage.list();
  }
  await flushBodyIndex(state, indexCtx).catch(() => undefined);
  state.stats.stages = usage.list();
  return { status, stats: state.stats, tokens: usage.totalTokens(), model: usage.primaryModel() };
}
