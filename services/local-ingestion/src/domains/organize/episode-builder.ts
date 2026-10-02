import { categorizeDomain } from "@study-studio/shared";
import { EPISODE_PARAMS, type EpisodeParams } from "./constants.js";
import type {
  ActivityEpisode,
  BuildEpisodesInput,
  BuildEpisodesResult,
  CapturedItemRef,
  DistractionMark,
  EpisodeSegment,
  JudgeTimelineEntry,
  LearningJudgeInput,
  OrganizeLearnerProfile,
  TimelineUnit
} from "./types.js";

const MS_PER_MIN = 60_000;

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function minutesBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / MS_PER_MIN;
}

function unitTime(unit: TimelineUnit): { start: string; end: string } {
  if (unit.kind === "page_session") return { start: unit.startedAt, end: unit.endedAt };
  return { start: unit.occurredAt, end: unit.occurredAt };
}

function isActivity(unit: TimelineUnit): boolean {
  return unit.kind !== "activity_state";
}

function defaultEpisodeId(startedAt: string, index: number): string {
  const d = new Date(startedAt);
  const stamp = Number.isNaN(d.getTime()) ? `ep_${index}` : `ep_${d.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  return `${stamp}_${index}`;
}

function formatClock(isoTime: string): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function sortUnits(units: TimelineUnit[]): TimelineUnit[] {
  return [...units].sort((a, b) => {
    const ta = Date.parse(unitTime(a).start);
    const tb = Date.parse(unitTime(b).start);
    return ta - tb || a.id.localeCompare(b.id);
  });
}

/** Resolve domain category; page_session already carries it, but callers may pass stale values. */
export function resolveUnitCategory(unit: TimelineUnit, extraUnrelated: string[] = []): TimelineUnit {
  if (unit.kind !== "page_session") return unit;
  const category = unit.category || categorizeDomain(unit.domain, extraUnrelated);
  return category === unit.category ? unit : { ...unit, category };
}

function hasJumpRelation(prev: TimelineUnit, next: TimelineUnit): boolean {
  if (prev.kind !== "page_session" || next.kind !== "page_session") return false;
  if (next.openerTabId !== undefined && prev.tabId !== undefined && next.openerTabId === prev.tabId) return true;
  if (next.referrer && prev.url && (next.referrer === prev.url || next.referrer.startsWith(prev.url))) return true;
  return false;
}

function sameSearchChain(prev: TimelineUnit, next: TimelineUnit, all: TimelineUnit[]): boolean {
  if (next.kind !== "page_session") return false;
  // Previous unit is a search, or previous page came from search and next shares referrer/tab.
  if (prev.kind === "search" && (next.tabId === undefined || prev.tabId === undefined || next.tabId === prev.tabId)) {
    return true;
  }
  if (prev.kind === "page_session" && next.referrer) {
    const searches = all.filter((u) => u.kind === "search");
    return searches.some((s) => s.kind === "search" && (s.tabId === undefined || s.tabId === next.tabId || s.tabId === prev.tabId));
  }
  return false;
}

function sameConversation(prev: TimelineUnit, next: TimelineUnit): boolean {
  const a = prev.kind === "ai_turn" ? prev.conversationId : prev.kind === "page_session" ? prev.conversationId : undefined;
  const b = next.kind === "ai_turn" ? next.conversationId : next.kind === "page_session" ? next.conversationId : undefined;
  return Boolean(a && b && a === b);
}

function shouldStitch(prev: TimelineUnit, next: TimelineUnit, all: TimelineUnit[], stitchGapMinutes: number): boolean {
  const gap = minutesBetween(unitTime(prev).end, unitTime(next).start);
  if (gap < stitchGapMinutes) return true;
  if (hasJumpRelation(prev, next)) return true;
  if (sameSearchChain(prev, next, all)) return true;
  if (sameConversation(prev, next)) return true;
  return false;
}

/**
 * Hard split: gap ≥ hardGapMinutes with no activity, or cluster longer than maxEpisodeHours
 * (split at the largest internal gap).
 */
function hardSplitClusters(units: TimelineUnit[], params: EpisodeParams): TimelineUnit[][] {
  const activity = units.filter(isActivity);
  if (activity.length === 0) return [];

  const clusters: TimelineUnit[][] = [];
  let current: TimelineUnit[] = [activity[0]!];

  for (let i = 1; i < activity.length; i++) {
    const prev = activity[i - 1]!;
    const next = activity[i]!;
    const gap = minutesBetween(unitTime(prev).end, unitTime(next).start);
    if (gap >= params.hardGapMinutes && !shouldStitch(prev, next, activity, params.stitchGapMinutes)) {
      clusters.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }
  clusters.push(current);

  // Split overlong clusters at the largest internal gap.
  const maxMs = params.maxEpisodeHours * 3_600_000;
  const result: TimelineUnit[][] = [];
  for (const cluster of clusters) {
    result.push(...splitOverlong(cluster, maxMs, params));
  }
  return result;
}

function splitOverlong(cluster: TimelineUnit[], maxMs: number, params: EpisodeParams): TimelineUnit[][] {
  if (cluster.length <= 1) return [cluster];
  const start = Date.parse(unitTime(cluster[0]!).start);
  const end = Date.parse(unitTime(cluster[cluster.length - 1]!).end);
  if (end - start <= maxMs) return [cluster];

  let bestIdx = 1;
  let bestGap = -1;
  for (let i = 1; i < cluster.length; i++) {
    const gap = Date.parse(unitTime(cluster[i]!).start) - Date.parse(unitTime(cluster[i - 1]!).end);
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  // Prefer splitting when gap is meaningful; otherwise midpoint.
  if (bestGap < params.stitchGapMinutes * MS_PER_MIN) {
    bestIdx = Math.floor(cluster.length / 2);
  }
  const left = cluster.slice(0, bestIdx);
  const right = cluster.slice(bestIdx);
  return [...splitOverlong(left, maxMs, params), ...splitOverlong(right, maxMs, params)].filter((c) => c.length > 0);
}

/**
 * Mark continuous unrelated runs inside a cluster; split off runs that never return
 * or exceed hardGapMinutes.
 */
function applyDistractionRules(
  cluster: TimelineUnit[],
  params: EpisodeParams
): { kept: TimelineUnit[]; distractions: DistractionMark[]; flags: Array<"long_distraction">; splitOff: TimelineUnit[][] } {
  const flags: Array<"long_distraction"> = [];
  const distractions: DistractionMark[] = [];
  const kept: TimelineUnit[] = [];
  const splitOff: TimelineUnit[][] = [];

  let i = 0;
  while (i < cluster.length) {
    const unit = cluster[i]!;
    if (unit.kind !== "page_session" || unit.category !== "unrelated") {
      kept.push(unit);
      i++;
      continue;
    }

    // Collect continuous unrelated page_sessions (and intervening non-learning-candidate signals).
    let j = i;
    let unrelatedSecs = 0;
    const run: TimelineUnit[] = [];
    while (j < cluster.length) {
      const u = cluster[j]!;
      if (u.kind === "page_session" && u.category === "unrelated") {
        run.push(u);
        unrelatedSecs += u.visibleSeconds;
        j++;
        continue;
      }
      if (u.kind === "page_session" && u.category === "learning_candidate") break;
      // Neutral / signals stay with the surrounding context; stop unrelated run.
      if (u.kind === "page_session" && u.category === "neutral") break;
      run.push(u);
      j++;
    }

    const durationMin = unrelatedSecs / 60;
    const startAt = unitTime(run[0]!).start;
    const endAt = unitTime(run[run.length - 1]!).end;
    const after = cluster[j];
    const returns = Boolean(after && after.kind === "page_session" && after.category === "learning_candidate");

    if (!returns || durationMin >= params.hardGapMinutes) {
      // Cut: do not attach to previous learning fragment.
      if (kept.length > 0) {
        splitOff.push(run);
      } else {
        // Leading unrelated with no return — keep as its own later cluster material via splitOff.
        splitOff.push(run);
      }
      i = j;
      continue;
    }

    if (durationMin < params.shortDistractionMinutes) {
      distractions.push({
        startAt,
        endAt,
        durationSec: unrelatedSecs,
        kind: "distraction",
        domain:
          run.find((r) => r.kind === "page_session")?.kind === "page_session"
            ? (run.find((r) => r.kind === "page_session") as Extract<TimelineUnit, { kind: "page_session" }>).domain
            : undefined
      });
      kept.push(...run);
    } else {
      flags.push("long_distraction");
      distractions.push({
        startAt,
        endAt,
        durationSec: unrelatedSecs,
        kind: "long_distraction",
        domain:
          run.find((r) => r.kind === "page_session")?.kind === "page_session"
            ? (run.find((r) => r.kind === "page_session") as Extract<TimelineUnit, { kind: "page_session" }>).domain
            : undefined
      });
      kept.push(...run);
    }
    i = j;
  }

  return { kept, distractions, flags, splitOff };
}

function activeSecondsOf(units: TimelineUnit[]): number {
  let sec = 0;
  for (const u of units) {
    if (u.kind === "page_session") sec += u.visibleSeconds;
    else if (u.kind === "ai_turn" || u.kind === "search" || u.kind === "note" || u.kind === "selection" || u.kind === "copy") sec += 30;
  }
  return sec;
}

function itemIdsOf(units: TimelineUnit[], items: CapturedItemRef[]): string[] {
  const ids = new Set<string>();
  for (const u of units) {
    if ("itemId" in u && u.itemId) ids.add(u.itemId);
  }
  const start = units[0] ? Date.parse(unitTime(units[0]).start) : 0;
  const end = units[units.length - 1] ? Date.parse(unitTime(units[units.length - 1]!).end) : 0;
  for (const item of items) {
    const t = Date.parse(item.capturedAt);
    if (!Number.isNaN(t) && t >= start && t <= end) ids.add(item.id);
  }
  return [...ids];
}

function hasLearningSignal(units: TimelineUnit[]): boolean {
  return units.some(
    (u) =>
      u.kind === "search" ||
      u.kind === "selection" ||
      u.kind === "copy" ||
      u.kind === "note" ||
      u.kind === "ai_turn" ||
      (u.kind === "page_session" && u.category === "learning_candidate")
  );
}

function buildJudgeTimeline(units: TimelineUnit[], distractions: DistractionMark[]): JudgeTimelineEntry[] {
  const entries: JudgeTimelineEntry[] = [];
  const distractionStarts = new Set(distractions.map((d) => d.startAt));

  for (const u of units) {
    const t = formatClock(unitTime(u).start);
    if (u.kind === "page_session" && u.category === "unrelated") {
      if (distractionStarts.has(u.startedAt) || distractions.some((d) => u.startedAt >= d.startAt && u.startedAt <= d.endAt)) {
        const mark = distractions.find((d) => u.startedAt >= d.startAt && u.startedAt <= d.endAt);
        if (mark && !entries.some((e) => e.kind === "distraction" && e.t === formatClock(mark.startAt))) {
          entries.push({
            t: formatClock(mark.startAt),
            kind: "distraction",
            domain_category: "unrelated",
            duration_sec: mark.durationSec,
            long: mark.kind === "long_distraction"
          });
        }
        continue;
      }
    }
    if (u.kind === "search") {
      entries.push({ t, kind: "search", query: u.query, engine: u.engine });
    } else if (u.kind === "page_session") {
      entries.push({
        t,
        kind: "page",
        title: u.title,
        domain: u.domain,
        category: u.category,
        active_sec: u.visibleSeconds,
        scroll: u.maxScrollDepth,
        captured_item_id: u.itemId ?? undefined,
        from: u.referrer ? "search_or_nav" : undefined,
        revisit: u.revisit
      });
    } else if (u.kind === "ai_turn") {
      entries.push({
        t,
        kind: "ai_turn",
        platform: u.platform,
        conversation_id: u.conversationId,
        question: u.question,
        turn_index: u.turnIndex,
        captured_item_id: u.itemId ?? undefined
      });
    } else if (u.kind === "selection" || u.kind === "copy") {
      entries.push({ t, kind: u.kind, text: u.text });
    } else if (u.kind === "note") {
      entries.push({ t, kind: "note", text: u.text });
    }
  }
  return entries;
}

function buildSegments(units: TimelineUnit[], distractions: DistractionMark[]): EpisodeSegment[] {
  if (units.length === 0) return [];
  const segments: EpisodeSegment[] = [];
  let current: TimelineUnit[] = [];
  let currentCat: EpisodeSegment["category"] | null = null;

  const flush = () => {
    if (!current.length) return;
    const startedAt = unitTime(current[0]!).start;
    const endedAt = unitTime(current[current.length - 1]!).end;
    const distraction = distractions.find((d) => d.startAt === startedAt);
    segments.push({
      unitIds: current.map((u) => u.id),
      category: currentCat ?? "mixed",
      startedAt,
      endedAt,
      distraction
    });
    current = [];
    currentCat = null;
  };

  for (const u of units) {
    const cat: EpisodeSegment["category"] =
      u.kind === "page_session" ? u.category : u.kind === "search" || u.kind === "ai_turn" || u.kind === "note" ? "learning_candidate" : "neutral";
    if (currentCat === null) currentCat = cat;
    else if (currentCat !== cat) {
      flush();
      currentCat = cat;
    }
    current.push(u);
  }
  flush();
  return segments;
}

function buildJudgeInput(
  episodeId: string,
  units: TimelineUnit[],
  distractions: DistractionMark[],
  flags: Array<"long_distraction">,
  learnerProfile: OrganizeLearnerProfile,
  recentKbTopics: string[]
): LearningJudgeInput {
  const start = unitTime(units[0]!).start;
  const end = unitTime(units[units.length - 1]!).end;
  const activeSeconds = activeSecondsOf(units);
  return {
    episode_id: episodeId,
    time_range: { start, end },
    active_minutes: Math.round((activeSeconds / 60) * 10) / 10,
    learner_profile: learnerProfile,
    recent_kb_topics: recentKbTopics,
    timeline: buildJudgeTimeline(units, distractions),
    flags
  };
}

function finalizeEpisode(
  units: TimelineUnit[],
  distractions: DistractionMark[],
  flags: Array<"long_distraction">,
  items: CapturedItemRef[],
  learnerProfile: OrganizeLearnerProfile,
  recentKbTopics: string[],
  now: Date,
  isManual: boolean,
  params: EpisodeParams,
  episodeId: string
): ActivityEpisode {
  const startedAt = unitTime(units[0]!).start;
  const endedAt = unitTime(units[units.length - 1]!).end;
  const activeSeconds = activeSecondsOf(units);
  const itemIds = itemIdsOf(units, items);
  const allUnrelated =
    units.every((u) => u.kind !== "page_session" || u.category === "unrelated") &&
    !hasLearningSignal(units.filter((u) => u.kind !== "page_session" || u.category === "unrelated")) &&
    itemIds.length === 0 &&
    units.every((u) => u.kind === "page_session" && u.category === "unrelated");

  const tooShort = activeSeconds < params.minActiveMinutes * 60 && !hasLearningSignal(units) && itemIds.length === 0;
  const minutesSinceEnd = (now.getTime() - Date.parse(endedAt)) / MS_PER_MIN;
  const isOpen = !isManual && minutesSinceEnd < params.openEpisodeMinutes;

  let status: ActivityEpisode["status"] = "ready";
  let prefilterReason: ActivityEpisode["prefilterReason"];
  if (allUnrelated) {
    status = "prefiltered";
    prefilterReason = "all_unrelated";
  } else if (tooShort) {
    status = "prefiltered";
    prefilterReason = "too_short";
  } else if (isOpen) {
    status = "open";
  }

  return {
    episodeId,
    startedAt,
    endedAt,
    activeSeconds,
    status,
    prefilterReason,
    flags: [...new Set(flags)],
    itemIds,
    segments: buildSegments(units, distractions),
    units,
    judgeInput: buildJudgeInput(episodeId, units, distractions, flags, learnerProfile, recentKbTopics)
  };
}

/**
 * ② Episode Builder — pure function.
 * Recall-oriented: prefer merging two learning sessions over shredding one.
 */
export function buildEpisodes(input: BuildEpisodesInput): BuildEpisodesResult {
  const params: EpisodeParams = { ...EPISODE_PARAMS, ...input.params };
  const items = input.items ?? [];
  const now = toDate(input.now ?? new Date());
  const isManual = Boolean(input.isManual);
  const idFor = input.episodeIdFor ?? defaultEpisodeId;
  const recentKbTopics = input.recentKbTopics ?? [];

  const sorted = sortUnits(input.units.map((u) => resolveUnitCategory(u)));
  const rawClusters = hardSplitClusters(sorted, params);

  const episodes: ActivityEpisode[] = [];
  let index = 0;

  for (const cluster of rawClusters) {
    const { kept, distractions, flags, splitOff } = applyDistractionRules(cluster, params);
    const pieces = kept.length ? [kept, ...splitOff] : splitOff;
    for (const piece of pieces) {
      if (!piece.length) continue;
      // Re-run distraction on split-off pure-unrelated pieces → usually prefiltered.
      const again = applyDistractionRules(piece, params);
      const units = again.kept.length ? again.kept : piece;
      if (!units.length) continue;
      const episode = finalizeEpisode(
        units,
        again.distractions.length ? again.distractions : distractions,
        [...flags, ...again.flags],
        items,
        input.learnerProfile,
        recentKbTopics,
        now,
        isManual,
        params,
        idFor(unitTime(units[0]!).start, index++)
      );
      episodes.push(episode);
    }
  }

  // Merge stitch candidates across hard-split boundaries that still share conversation / jump.
  // (hardSplit already respects stitch; this is a safety no-op for most cases.)

  const deferredOpen = episodes.filter((e) => e.status === "open");
  const active = episodes.filter((e) => e.status !== "open");
  return { episodes: isManual ? episodes : active.concat(deferredOpen), deferredOpen: isManual ? [] : deferredOpen };
}

/**
 * Apply a single round of segment_suggestion from ③.
 * Returns null when suggestion is keep / already applied / cannot apply.
 */
export function applySegmentSuggestion(
  episodes: ActivityEpisode[],
  episodeId: string,
  suggestion: { action: "keep" | "split" | "merge"; at?: string; with_episode_id?: string },
  alreadyCorrected: boolean
): { applied: boolean; episodes: ActivityEpisode[]; reason?: string } {
  if (alreadyCorrected) return { applied: false, episodes, reason: "already_corrected_once" };
  if (suggestion.action === "keep") return { applied: false, episodes, reason: "keep" };

  const idx = episodes.findIndex((e) => e.episodeId === episodeId);
  if (idx < 0) return { applied: false, episodes, reason: "episode_not_found" };

  if (suggestion.action === "split") {
    const ep = episodes[idx]!;
    const at = suggestion.at;
    if (!at) return { applied: false, episodes, reason: "missing_at" };
    let cut = ep.units.findIndex((u) => {
      const start = unitTime(u).start;
      return start === at || formatClock(start) === at || start.includes(at);
    });
    if (cut <= 0) cut = Math.floor(ep.units.length / 2);
    if (cut <= 0 || cut >= ep.units.length) return { applied: false, episodes, reason: "cannot_split" };
    const leftUnits = ep.units.slice(0, cut);
    const rightUnits = ep.units.slice(cut);
    const left: ActivityEpisode = {
      ...ep,
      episodeId: `${ep.episodeId}_a`,
      endedAt: unitTime(leftUnits[leftUnits.length - 1]!).end,
      units: leftUnits,
      itemIds: itemIdsOf(leftUnits, []),
      activeSeconds: activeSecondsOf(leftUnits),
      judgeInput: {
        ...ep.judgeInput,
        episode_id: `${ep.episodeId}_a`,
        time_range: { start: unitTime(leftUnits[0]!).start, end: unitTime(leftUnits[leftUnits.length - 1]!).end }
      }
    };
    const right: ActivityEpisode = {
      ...ep,
      episodeId: `${ep.episodeId}_b`,
      startedAt: unitTime(rightUnits[0]!).start,
      units: rightUnits,
      itemIds: itemIdsOf(rightUnits, []),
      activeSeconds: activeSecondsOf(rightUnits),
      judgeInput: {
        ...ep.judgeInput,
        episode_id: `${ep.episodeId}_b`,
        time_range: { start: unitTime(rightUnits[0]!).start, end: unitTime(rightUnits[rightUnits.length - 1]!).end }
      }
    };
    const next = [...episodes.slice(0, idx), left, right, ...episodes.slice(idx + 1)];
    return { applied: true, episodes: next };
  }

  if (suggestion.action === "merge") {
    const otherId = suggestion.with_episode_id;
    if (!otherId) return { applied: false, episodes, reason: "missing_with_episode_id" };
    const otherIdx = episodes.findIndex((e) => e.episodeId === otherId);
    if (otherIdx < 0) return { applied: false, episodes, reason: "other_not_found" };
    const a = episodes[idx]!;
    const b = episodes[otherIdx]!;
    const [first, second] = Date.parse(a.startedAt) <= Date.parse(b.startedAt) ? [a, b] : [b, a];
    const mergedUnits = [...first.units, ...second.units];
    const merged: ActivityEpisode = {
      ...first,
      episodeId: first.episodeId,
      endedAt: second.endedAt,
      units: mergedUnits,
      itemIds: [...new Set([...first.itemIds, ...second.itemIds])],
      activeSeconds: first.activeSeconds + second.activeSeconds,
      flags: [...new Set([...first.flags, ...second.flags])],
      judgeInput: {
        ...first.judgeInput,
        time_range: { start: first.startedAt, end: second.endedAt },
        active_minutes: Math.round(((first.activeSeconds + second.activeSeconds) / 60) * 10) / 10,
        flags: [...new Set([...first.flags, ...second.flags])]
      }
    };
    const rest = episodes.filter((_, i) => i !== idx && i !== otherIdx);
    return { applied: true, episodes: [...rest, merged].sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt)) };
  }

  return { applied: false, episodes };
}

/** Whether ③ should be re-invoked after applying a segment suggestion (at most one round). */
export function shouldRejudgeAfterSuggestion(
  suggestion: { action: "keep" | "split" | "merge"; at?: string; with_episode_id?: string },
  alreadyCorrected: boolean
): boolean {
  if (alreadyCorrected) return false;
  return suggestion.action === "split" || suggestion.action === "merge";
}
