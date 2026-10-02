/**
 * Tunable constants for the organize pipeline (07).
 * M7 will calibrate similarity / engagement thresholds from labeled samples.
 */

/** ② Episode Builder */
export const EPISODE_PARAMS = {
  hardGapMinutes: 30,
  stitchGapMinutes: 10,
  shortDistractionMinutes: 15,
  maxEpisodeHours: 4,
  minActiveMinutes: 2,
  openEpisodeMinutes: 30
} as const;

export type EpisodeParams = {
  -readonly [K in keyof typeof EPISODE_PARAMS]: number;
};

/** ④ Retrieve & Prefilter scoring */
export const PREFILTER_PARAMS = {
  /** Drop related entries below this semantic similarity. */
  similarityDiscardThreshold: 0.55,
  /** Near-duplicate by max similarity when the item has no note/highlight. */
  nearDuplicateSimilarity: 0.93,
  /** Keep at most this many related entries per item. */
  topRelatedEntries: 5,
  /** Recency half-life in days for `0.5^(Δdays / halfLife)`. */
  recencyHalfLifeDays: 21,
  /** Floor for recency_weight so old knowledge still matters. */
  recencyFloor: 0.3,
  /** Max Hamming distance (64-bit SimHash) treated as near-duplicate content. */
  simhashMaxHammingDistance: 3,
  /** Plain-text length (non-whitespace) below which content is low_information. */
  minContentChars: 200,
  /** Link-character share above which content is navigational. */
  maxLinkDensity: 0.5,
  /** Shortest non-link paragraph (chars) expected of real prose. */
  minParagraphChars: 60
} as const;

export type PrefilterParams = {
  -readonly [K in keyof typeof PREFILTER_PARAMS]: number;
};

/** ⑤ Code-side value_score thresholds τ by engagement (plus uncertain boost). */
export const ENGAGEMENT_TAU = {
  strong: 0.4,
  medium: 0.5,
  weak: 0.6,
  uncertainBoost: 0.2
} as const;

export type EngagementLevel = "strong" | "medium" | "weak";

/** ⑥ Alignment: name embedding similarity injected by the caller (no model call here). */
export const ALIGN_PARAMS = {
  nameEmbeddingThreshold: 0.92
} as const;

/** ⑦ Entry rewrite hint when patches accumulate. */
export const ENTRY_REWRITE_PARAMS = {
  suggestRewritePatchCount: 8
} as const;

/** Listing URL patterns (同源采集层列表页规则，见 page-extractor). */
export const LISTING_PATH = /\/(search|tags?|categories|category|topics|explore|trending|hot|feed|page\/\d+)(\/|$)/i;
export const SEARCH_QUERY_PARAMS = ["q", "query", "keyword", "keywords", "wd", "kw"] as const;

/** Prompt version placeholder used in `input_hash` until prompts land in M5 prompts agent. */
export const DEFAULT_PROMPT_VERSION = "organize-v1";
