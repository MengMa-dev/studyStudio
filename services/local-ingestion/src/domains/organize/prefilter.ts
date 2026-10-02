import { PREFILTER_PARAMS, type PrefilterParams } from "./constants.js";
import { assessContentQuality } from "./content-quality.js";
import { normalizeEntryName } from "./normalize.js";
import { rankRelatedEntries } from "./scoring.js";
import { computeSimhash, parseSimhash, simhashNearDuplicate } from "./simhash.js";
import type { PrefilterInput, PrefilterResult, ScoredRelatedEntry } from "./types.js";

function mergeParams(partial?: Partial<PrefilterParams>): PrefilterParams {
  return { ...PREFILTER_PARAMS, ...partial };
}

function ignoredMatches(names: Array<string | null | undefined>, kbIgnore: string[]): string[] {
  const ignore = new Set(kbIgnore.map(normalizeEntryName));
  const hits: string[] = [];
  for (const name of names) {
    if (!name) continue;
    if (ignore.has(normalizeEntryName(name))) hits.push(name);
  }
  return [...new Set(hits)];
}

function itemBodyText(item: PrefilterInput["item"]): string {
  return (item.markdown || item.plain_text || "").trim();
}

function findSimhashDuplicate(
  item: PrefilterInput["item"],
  fingerprints: NonNullable<PrefilterInput["source_fingerprints"]>,
  maxDistance: number
): string | null {
  if (item.content_hash) {
    const byHash = fingerprints.find((f) => f.content_hash && f.content_hash === item.content_hash);
    if (byHash) return byHash.entry_id;
  }
  const itemHash =
    parseSimhash(item.simhash) ??
    (() => {
      const text = itemBodyText(item);
      return text ? computeSimhash(text) : null;
    })();
  if (itemHash === null) return null;
  for (const fp of fingerprints) {
    const other = parseSimhash(fp.simhash);
    if (other === null) continue;
    if (simhashNearDuplicate(itemHash, other, maxDistance)) return fp.entry_id;
  }
  return null;
}

/**
 * ④ Rule prefilter + related-entry scoring.
 * Returns `route=prefilter:<rule>` on hit, otherwise `route=llm` with ranked related_entries.
 *
 * Order: kb_ignore → content near-dupe (hash/SimHash) → high similarity dupe → navigational/low_info.
 * Items with note or highlight are never rule-rejected (still may be duplicate).
 */
export function prefilterItem(input: PrefilterInput): PrefilterResult {
  const params = mergeParams(input.params);
  const now = input.now ?? new Date();
  const related = rankRelatedEntries(input.related_candidates, now, params);
  const ignored = ignoredMatches([input.item.title, input.item.topic, ...related.map((r) => r.name)], input.kb_ignore_names);

  const titleIgnored = ignoredMatches([input.item.title, input.item.topic], input.kb_ignore_names);
  if (titleIgnored.length > 0) {
    return {
      route: "prefilter:kb_ignore",
      decision: "reject",
      reject_reason: "ignored",
      related_entries: related,
      ignored_matches: [...new Set([...ignored, ...titleIgnored])]
    };
  }

  const fingerprints = input.source_fingerprints ?? [];
  const nearDupEntry = findSimhashDuplicate(input.item, fingerprints, params.simhashMaxHammingDistance);
  if (nearDupEntry) {
    return {
      route: "prefilter:simhash_duplicate",
      decision: "duplicate",
      target_entry_ids: [nearDupEntry],
      related_entries: related,
      ignored_matches: ignored,
      evidence: {
        title: input.item.title,
        excerpt: itemBodyText(input.item).slice(0, 240) || undefined
      }
    };
  }

  const top = related[0];
  if (top && top.similarity >= params.nearDuplicateSimilarity && !input.item.has_note && !input.item.has_highlight) {
    return {
      route: "prefilter:similarity_duplicate",
      decision: "duplicate",
      target_entry_ids: [top.entry_id],
      related_entries: related,
      ignored_matches: ignored,
      evidence: { title: input.item.title }
    };
  }

  const quality = assessContentQuality(
    {
      plain_text: input.item.plain_text,
      markdown: input.item.markdown,
      url: input.item.url
    },
    params
  );
  if (!quality.ok) {
    // 兜底：带备注或高亮的条目不会被规则判 reject
    if (input.item.has_note || input.item.has_highlight) {
      return { route: "llm", related_entries: related, ignored_matches: ignored };
    }
    const ruleName =
      quality.rule === "listing_url" || quality.rule === "link_density" || quality.rule === "thin_paragraphs" ? "navigational" : "low_information";
    return {
      route: `prefilter:${ruleName}`,
      decision: "reject",
      reject_reason: quality.reject_reason,
      related_entries: related,
      ignored_matches: ignored
    };
  }

  return { route: "llm", related_entries: related, ignored_matches: ignored };
}

/** Helper for integration: score-only (no rule hits). */
export function scoreOnly(input: Pick<PrefilterInput, "related_candidates" | "now" | "params">): ScoredRelatedEntry[] {
  return rankRelatedEntries(input.related_candidates, input.now ?? new Date(), mergeParams(input.params));
}
