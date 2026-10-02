import { ENGAGEMENT_TAU, type EngagementLevel } from "./constants.js";
import type { SegmentSuggestion, ValueScoreFallbackInput, ValueScoreFallbackResult } from "./types.js";

/** τ for value_score fallback: engagement base + optional uncertain boost. */
export function engagementThreshold(engagement: EngagementLevel, uncertain = false): number {
  const base = ENGAGEMENT_TAU[engagement];
  const raw = uncertain ? base + ENGAGEMENT_TAU.uncertainBoost : base;
  return Math.min(1, Math.round(raw * 1000) / 1000);
}

/**
 * ⑤ Code-side兜底：decision ∈ {new, supplement} 且 value_score < τ → reject(low_information).
 * 采纳模式不做此兜底。
 */
export function applyValueScoreFallback(input: ValueScoreFallbackInput): ValueScoreFallbackResult {
  const tau = engagementThreshold(input.engagement, Boolean(input.uncertain));
  if (input.adopt_mode) {
    return { decision: input.decision, value_score: input.value_score, overridden: false, tau };
  }
  if ((input.decision === "new" || input.decision === "supplement") && input.value_score < tau) {
    return {
      decision: "reject",
      value_score: input.value_score,
      reject_reason: "low_information",
      overridden: true,
      tau
    };
  }
  return { decision: input.decision, value_score: input.value_score, overridden: false, tau };
}

const ADOPT_DECISIONS = new Set(["new", "supplement", "duplicate"]);

/**
 * 采纳模式：decision 限定为 new / supplement / duplicate（不做 reject / 价值兜底）。
 * 若模型仍输出 reject，调用方应重试；此函数把非法 decision 标为 invalid。
 */
export function constrainAdoptDecision(
  decision: "new" | "supplement" | "duplicate" | "reject"
): { ok: true; decision: "new" | "supplement" | "duplicate" } | { ok: false; decision: "reject"; reason: "adopt_mode_forbids_reject" } {
  if (ADOPT_DECISIONS.has(decision)) {
    return { ok: true, decision: decision as "new" | "supplement" | "duplicate" };
  }
  return { ok: false, decision: "reject", reason: "adopt_mode_forbids_reject" };
}

/**
 * `segment_suggestion` 最多修正一轮：keep 不触发；split/merge 仅在尚未修正过时触发重判。
 */
export function decideSegmentCorrection(
  suggestion: SegmentSuggestion,
  alreadyCorrected: boolean
): { shouldApply: boolean; shouldRejudge: boolean; reason: string } {
  if (suggestion.action === "keep") {
    return { shouldApply: false, shouldRejudge: false, reason: "keep" };
  }
  if (alreadyCorrected) {
    return { shouldApply: false, shouldRejudge: false, reason: "max_one_round" };
  }
  return { shouldApply: true, shouldRejudge: true, reason: suggestion.action };
}

/**
 * ③ 置信度分支（决策函数，供 worker 使用）。
 * ≥0.7 → proceed；[0.4,0.7) → proceed+uncertain；<0.4 / 非学习 / 不值得抽取 → reject。
 * 带备注或高亮的条目不会在此被直接标未采纳。
 */
export function decideAfterLearningJudge(input: {
  is_learning: boolean;
  confidence: number;
  worth_extracting: boolean;
  candidate_item_ids: string[];
  /** item_id → has note or highlight */
  protected_item_ids?: string[];
}): {
  action: "proceed" | "proceed_uncertain" | "reject_episode";
  force_include_item_ids: string[];
} {
  const protectedIds = new Set(input.protected_item_ids ?? []);
  const force = [...protectedIds];

  if (!input.is_learning || !input.worth_extracting || input.confidence < 0.4) {
    if (force.length > 0) {
      return { action: input.confidence >= 0.4 && input.confidence < 0.7 ? "proceed_uncertain" : "proceed", force_include_item_ids: force };
    }
    return { action: "reject_episode", force_include_item_ids: [] };
  }
  if (input.confidence < 0.7) {
    return { action: "proceed_uncertain", force_include_item_ids: force };
  }
  return { action: "proceed", force_include_item_ids: force };
}
