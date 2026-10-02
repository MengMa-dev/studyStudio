import type { DomainCategory, SourceKind } from "@study-studio/shared";
import type { EngagementLevel, EpisodeParams, PrefilterParams } from "./constants.js";

/** Minimal learner profile shape passed into judge / processing (active directions only). */
export type OrganizeLearnerProfile = {
  role: string;
  learning_focus: Array<{ topic: string; expires_at?: string } | string>;
};

/** Captured item reference available inside an activity window (② / ④). */
export type CapturedItemRef = {
  id: string;
  type: "webpage" | "conversation" | "document";
  title?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  site?: string | null;
  capturedAt: string;
  conversationId?: string | null;
  contentHash?: string | null;
  plainText?: string | null;
  markdown?: string | null;
  hasNote?: boolean;
  hasHighlight?: boolean;
  highlights?: string[];
  noteText?: string | null;
};

/**
 * Normalized timeline units for episode building.
 * Integration maps `events` + items into this shape before calling ②.
 */
export type TimelineUnit =
  | {
      kind: "page_session";
      id: string;
      occurredAt: string;
      domain: string;
      category: DomainCategory;
      url?: string;
      title?: string;
      referrer?: string;
      openerTabId?: number;
      tabId?: number;
      transition?: string;
      startedAt: string;
      endedAt: string;
      visibleSeconds: number;
      maxScrollDepth?: number;
      revisit?: boolean;
      captured?: boolean;
      itemId?: string | null;
      conversationId?: string | null;
    }
  | {
      kind: "search";
      id: string;
      occurredAt: string;
      engine: string;
      query: string;
      tabId?: number;
    }
  | {
      kind: "selection" | "copy";
      id: string;
      occurredAt: string;
      text: string;
      isCode: boolean;
      url?: string;
      itemId?: string | null;
    }
  | {
      kind: "ai_turn";
      id: string;
      occurredAt: string;
      platform?: string;
      conversationId?: string;
      question?: string;
      turnIndex?: number;
      itemId?: string | null;
    }
  | {
      kind: "note";
      id: string;
      occurredAt: string;
      text: string;
      itemId?: string | null;
    }
  | {
      kind: "activity_state";
      id: string;
      occurredAt: string;
      state: "idle" | "active" | "blur" | "focus";
    };

export type DistractionMark = {
  startAt: string;
  endAt: string;
  durationSec: number;
  kind: "distraction" | "long_distraction";
  domain?: string;
};

export type EpisodeSegment = {
  unitIds: string[];
  category: DomainCategory | "mixed";
  startedAt: string;
  endedAt: string;
  distraction?: DistractionMark;
};

export type JudgeTimelineEntry =
  | {
      t: string;
      kind: "search";
      query: string;
      engine: string;
    }
  | {
      t: string;
      kind: "page";
      title?: string;
      domain: string;
      category: DomainCategory;
      active_sec: number;
      scroll?: number;
      captured_item_id?: string;
      from?: string;
      revisit?: boolean;
    }
  | {
      t: string;
      kind: "ai_turn";
      platform?: string;
      conversation_id?: string;
      question?: string;
      turn_index?: number;
      captured_item_id?: string;
    }
  | {
      t: string;
      kind: "selection" | "copy";
      text: string;
    }
  | {
      t: string;
      kind: "distraction";
      domain_category?: string;
      duration_sec: number;
      long?: boolean;
    }
  | {
      t: string;
      kind: "note";
      text: string;
    };

/** ③ Learning Judge input (behavior summary only, no page bodies). */
export type LearningJudgeInput = {
  episode_id: string;
  time_range: { start: string; end: string };
  active_minutes: number;
  learner_profile: OrganizeLearnerProfile;
  recent_kb_topics: string[];
  timeline: JudgeTimelineEntry[];
  flags: Array<"long_distraction">;
};

export type EpisodeStatus = "open" | "prefiltered" | "ready";

export type ActivityEpisode = {
  episodeId: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  status: EpisodeStatus;
  /** Set when status=prefiltered (rule non-learning). */
  prefilterReason?: "all_unrelated" | "too_short";
  flags: Array<"long_distraction">;
  itemIds: string[];
  segments: EpisodeSegment[];
  units: TimelineUnit[];
  judgeInput: LearningJudgeInput;
};

export type BuildEpisodesInput = {
  units: TimelineUnit[];
  items?: CapturedItemRef[];
  learnerProfile: OrganizeLearnerProfile;
  recentKbTopics?: string[];
  /** Wall clock for `open` detection; defaults to now. */
  now?: string | Date;
  /** Manual organize never defers open episodes. */
  isManual?: boolean;
  params?: Partial<EpisodeParams>;
  /** Optional id factory for deterministic tests. */
  episodeIdFor?: (startedAt: string, index: number) => string;
};

export type BuildEpisodesResult = {
  episodes: ActivityEpisode[];
  deferredOpen: ActivityEpisode[];
};

/** Related KB entry after ④ scoring. */
export type ScoredRelatedEntry = {
  entry_id: string;
  name: string;
  summary?: string;
  similarity: number;
  recency_weight: number;
  recency_relevance: number;
  last_source_at: string;
  mastery?: number | null;
};

export type RelatedCandidate = {
  entry_id: string;
  name: string;
  summary?: string;
  similarity: number;
  last_source_at: string;
  mastery?: number | null;
  content_hash?: string | null;
  /** 64-bit SimHash as unsigned bigint or decimal string. */
  simhash?: bigint | string | number | null;
};

export type SourceFingerprint = {
  entry_id: string;
  content_hash?: string | null;
  simhash?: bigint | string | number | null;
};

export type PrefilterItemInput = {
  item_id: string;
  title?: string | null;
  topic?: string | null;
  url?: string | null;
  content_hash?: string | null;
  plain_text?: string | null;
  markdown?: string | null;
  /** Precomputed SimHash of item body; computed from text when omitted. */
  simhash?: bigint | string | number | null;
  has_note: boolean;
  has_highlight: boolean;
};

export type PrefilterInput = {
  item: PrefilterItemInput;
  related_candidates: RelatedCandidate[];
  /** Fingerprints of already-ingested sources for near-duplicate detection. */
  source_fingerprints?: SourceFingerprint[];
  kb_ignore_names: string[];
  now?: string | Date;
  params?: Partial<PrefilterParams>;
};

export type PrefilterRejectReason = "ignored" | "navigational" | "low_information";

export type PrefilterHit =
  | {
      route: `prefilter:${string}`;
      decision: "reject";
      reject_reason: PrefilterRejectReason;
      related_entries: ScoredRelatedEntry[];
      ignored_matches: string[];
    }
  | {
      route: `prefilter:${string}`;
      decision: "duplicate";
      target_entry_ids: string[];
      related_entries: ScoredRelatedEntry[];
      ignored_matches: string[];
      evidence?: { title?: string | null; highlights?: string[]; excerpt?: string };
    };

export type PrefilterPass = {
  route: "llm";
  related_entries: ScoredRelatedEntry[];
  ignored_matches: string[];
};

export type PrefilterResult = PrefilterHit | PrefilterPass;

export type PatchOp =
  | { op: "append_to_section"; section: string; markdown: string }
  | { op: "add_section"; after: string; heading: string; markdown: string }
  | { op: "replace_section"; section: string; markdown: string };

export type ExistingEntryRef = {
  id: string;
  name: string;
  aliases: string[];
  kind?: string | null;
  deleted?: boolean;
};

export type AlignmentInput = {
  match: string;
  name: string;
  aliases?: string[];
  kind?: string | null;
  /** Full new-entry body when match="new"; demoted to add_section「补充」on rematch. */
  body_markdown?: string | null;
  existing_entries: ExistingEntryRef[];
  kb_ignore_names: string[];
  /**
   * Precomputed name embedding similarities (caller injects; threshold default 0.92).
   * Only consulted when exact normalized name/alias miss.
   */
  name_similarities?: Array<{ entry_id: string; similarity: number; kind?: string | null }>;
  name_embedding_threshold?: number;
};

export type AlignmentDecision =
  | { action: "discard"; reason: "kb_ignore" }
  | { action: "use_existing"; entry_id: string; via: "match" | "normalized_name" | "embedding"; add_alias?: string; demote_body_to_supplement?: boolean }
  | { action: "create_new"; name: string; aliases: string[] };

export type ApplyPatchInput = {
  body_markdown: string;
  ops: PatchOp[];
  user_edited?: boolean;
  /** Current patch_count before this apply; returned incremented when body changes. */
  patch_count?: number;
};

export type ApplyPatchResult = {
  body_markdown: string;
  /** Original section bodies replaced (for organize_results.output rollback). */
  replaced_sections: Array<{ section: string; previous_markdown: string }>;
  /** Ops that fell back to end-of-doc add_section because the heading was missing. */
  degraded_ops: Array<{ original: PatchOp; heading: string }>;
  /** True when content was appended under 「整理建议」 instead of mutating the body. */
  wrote_suggestion: boolean;
  patch_count: number;
};

export type InputHashParts = {
  /** Item body used for processing (edited markdown preferred). */
  content: string;
  /** Notes actually used (item note + matched fuzzy + requirement). */
  notes: string[];
  /** Learning-judge result for the owning episode (stable JSON fields). */
  judge_result: unknown;
  prompt_version: string;
};

export type OrganizeRunCounters = {
  episodes_learning: number;
  episodes_non_learning: number;
  episodes_deferred: number;
  items_ingested: number;
  items_rejected: number;
  items_failed: number;
  prefilter_hits: number;
  kb_entries_created: number;
  kb_edges_created: number;
  kb_entries_supplemented: number;
  kb_entries_rewritten: number;
  reject_reasons: Record<string, number>;
};

export type OrganizeRunStatEvent =
  | { type: "episode"; status: "learning" | "non_learning" | "deferred" }
  | { type: "item"; outcome: "ingested" | "rejected" | "failed"; reject_reason?: string; via_prefilter?: boolean }
  | { type: "kb"; change: "created" | "supplemented" | "rewritten" | "edge" };

export type SegmentSuggestion = {
  action: "keep" | "split" | "merge";
  at?: string;
  with_episode_id?: string;
};

export type ValueScoreFallbackInput = {
  decision: "new" | "supplement" | "duplicate" | "reject";
  value_score: number;
  engagement: EngagementLevel;
  uncertain?: boolean;
  /** Manual adopt path: no τ fallback; decision already constrained. */
  adopt_mode?: boolean;
};

export type ValueScoreFallbackResult = {
  decision: "new" | "supplement" | "duplicate" | "reject";
  value_score: number;
  reject_reason?: "low_information";
  overridden: boolean;
  tau: number;
};

export type { EngagementLevel, EpisodeParams, PrefilterParams, SourceKind };
