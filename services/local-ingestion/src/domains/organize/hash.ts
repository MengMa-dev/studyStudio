import { createHash } from "node:crypto";
import { DEFAULT_PROMPT_VERSION } from "./constants.js";
import type { InputHashParts, OrganizeRunCounters, OrganizeRunStatEvent } from "./types.js";

/** Stable JSON stringify: sorted object keys, no whitespace variance. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * input_hash = hash(正文 + 使用的备注 + 所属片段的判定结果 + prompt_version)
 * SHA-256 hex; stable across key order in judge_result.
 */
export function computeInputHash(parts: InputHashParts): string {
  const payload = stableStringify({
    content: parts.content,
    notes: [...parts.notes]
      .map((n) => n.trim())
      .filter(Boolean)
      .sort(),
    judge_result: parts.judge_result ?? null,
    prompt_version: parts.prompt_version || DEFAULT_PROMPT_VERSION
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Skip re-processing when the stored hash still matches. */
export function isInputUnchanged(storedHash: string | null | undefined, nextHash: string): boolean {
  return Boolean(storedHash && storedHash === nextHash);
}

/** Entry becomes stale when a source item is deleted (caller sets flag); helper for clarity. */
export function shouldRewriteStaleEntry(stale: boolean | 0 | 1 | null | undefined): boolean {
  return stale === true || stale === 1;
}

export function emptyOrganizeRunCounters(): OrganizeRunCounters {
  return {
    episodes_learning: 0,
    episodes_non_learning: 0,
    episodes_deferred: 0,
    items_ingested: 0,
    items_rejected: 0,
    items_failed: 0,
    prefilter_hits: 0,
    kb_entries_created: 0,
    kb_edges_created: 0,
    kb_entries_supplemented: 0,
    kb_entries_rewritten: 0,
    reject_reasons: {}
  };
}

/** Aggregate organize_runs.stats from a stream of typed events. */
export function aggregateOrganizeRunStats(events: OrganizeRunStatEvent[]): OrganizeRunCounters {
  const stats = emptyOrganizeRunCounters();
  for (const event of events) {
    if (event.type === "episode") {
      if (event.status === "learning") stats.episodes_learning += 1;
      else if (event.status === "non_learning") stats.episodes_non_learning += 1;
      else stats.episodes_deferred += 1;
      continue;
    }
    if (event.type === "item") {
      if (event.outcome === "ingested") stats.items_ingested += 1;
      else if (event.outcome === "rejected") {
        stats.items_rejected += 1;
        if (event.reject_reason) {
          stats.reject_reasons[event.reject_reason] = (stats.reject_reasons[event.reject_reason] ?? 0) + 1;
        }
      } else stats.items_failed += 1;
      if (event.via_prefilter) stats.prefilter_hits += 1;
      continue;
    }
    if (event.type === "kb") {
      if (event.change === "created") stats.kb_entries_created += 1;
      else if (event.change === "supplemented") stats.kb_entries_supplemented += 1;
      else if (event.change === "rewritten") stats.kb_entries_rewritten += 1;
      else if (event.change === "edge") stats.kb_edges_created += 1;
    }
  }
  return stats;
}

export function nextPatchCount(current: number, bodyChanged: boolean): number {
  return bodyChanged ? current + 1 : current;
}

export function resetPatchCountAfterRewrite(): number {
  return 0;
}
