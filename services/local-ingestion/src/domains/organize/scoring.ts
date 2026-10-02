import { PREFILTER_PARAMS, type PrefilterParams } from "./constants.js";
import type { RelatedCandidate, ScoredRelatedEntry } from "./types.js";

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso.length === 10 ? `${fromIso}T00:00:00Z` : fromIso);
  const to = Date.parse(toIso.length === 10 ? `${toIso}T00:00:00Z` : toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, (to - from) / 86_400_000);
}

/**
 * recency_weight = max(0.5^(Δdays / halfLife), floor)
 * similarity is never decayed — duplicates stay duplicates.
 */
export function recencyWeight(
  lastSourceAt: string,
  now: string | Date = new Date(),
  params: Pick<PrefilterParams, "recencyHalfLifeDays" | "recencyFloor"> = PREFILTER_PARAMS
): number {
  const nowIso = typeof now === "string" ? now : now.toISOString();
  const delta = daysBetween(lastSourceAt, nowIso);
  const raw = Math.pow(0.5, delta / params.recencyHalfLifeDays);
  return Math.max(raw, params.recencyFloor);
}

export function scoreRelatedEntry(
  candidate: RelatedCandidate,
  now: string | Date = new Date(),
  params: Pick<PrefilterParams, "recencyHalfLifeDays" | "recencyFloor"> = PREFILTER_PARAMS
): ScoredRelatedEntry {
  const weight = recencyWeight(candidate.last_source_at, now, params);
  return {
    entry_id: candidate.entry_id,
    name: candidate.name,
    summary: candidate.summary,
    similarity: candidate.similarity,
    recency_weight: weight,
    recency_relevance: candidate.similarity * weight,
    last_source_at: candidate.last_source_at,
    mastery: candidate.mastery ?? null
  };
}

/** Merge, drop below threshold, keep top-N by similarity (duplicate detection uses raw similarity). */
export function rankRelatedEntries(
  candidates: RelatedCandidate[],
  now: string | Date = new Date(),
  params: Pick<PrefilterParams, "similarityDiscardThreshold" | "topRelatedEntries" | "recencyHalfLifeDays" | "recencyFloor"> = PREFILTER_PARAMS
): ScoredRelatedEntry[] {
  const byId = new Map<string, RelatedCandidate>();
  for (const c of candidates) {
    const prev = byId.get(c.entry_id);
    if (!prev || c.similarity > prev.similarity) byId.set(c.entry_id, c);
  }
  return [...byId.values()]
    .filter((c) => c.similarity >= params.similarityDiscardThreshold)
    .map((c) => scoreRelatedEntry(c, now, params))
    .sort((a, b) => b.similarity - a.similarity || b.recency_relevance - a.recency_relevance)
    .slice(0, params.topRelatedEntries);
}
