import { LISTING_PATH, PREFILTER_PARAMS, SEARCH_QUERY_PARAMS, type PrefilterParams } from "./constants.js";

const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)]+/gi;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+.*$/gm;

export type ContentQualityVerdict =
  { ok: true } | { ok: false; reject_reason: "navigational" | "low_information"; rule: "listing_url" | "short_body" | "link_density" | "thin_paragraphs" };

function nonWsLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** URL looks like a home / search / tag listing (同源采集层). */
export function isListingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") return true;
    if (LISTING_PATH.test(parsed.pathname)) return true;
    return SEARCH_QUERY_PARAMS.some((key) => parsed.searchParams.get(key));
  } catch {
    return false;
  }
}

/** Approximate link density on markdown / plain text without a DOM. */
export function linkDensityOf(text: string): { total: number; linkChars: number; density: number } {
  let linkChars = 0;
  const md = text.replace(MD_LINK, (_full, href: string) => {
    const label = _full.slice(1, _full.indexOf("]"));
    linkChars += nonWsLength(label) + nonWsLength(href);
    return " ";
  });
  md.replace(BARE_URL, (url) => {
    linkChars += nonWsLength(url);
    return " ";
  });
  const total = nonWsLength(text);
  return { total, linkChars, density: total ? linkChars / total : 1 };
}

function longestProseRun(text: string): number {
  const withoutLinks = text.replace(MD_LINK, " ").replace(BARE_URL, " ");
  const blocks = withoutLinks.split(/\n{2,}/);
  let max = 0;
  for (const block of blocks) {
    const line = block.replace(/\s+/g, "");
    if (line.length > max) max = line.length;
  }
  return max;
}

function listItemCount(text: string): number {
  return [...text.matchAll(LIST_ITEM)].length;
}

/**
 * Navigational / low-information heuristics aligned with collector list-page rules,
 * operating on markdown/plain text (+ optional URL) since organize has no DOM.
 */
export function assessContentQuality(
  input: { plain_text?: string | null; markdown?: string | null; url?: string | null },
  params: Pick<PrefilterParams, "minContentChars" | "maxLinkDensity" | "minParagraphChars"> = PREFILTER_PARAMS
): ContentQualityVerdict {
  if (isListingUrl(input.url)) {
    return { ok: false, reject_reason: "navigational", rule: "listing_url" };
  }
  const text = (input.markdown || input.plain_text || "").trim();
  if (!text) {
    return { ok: false, reject_reason: "low_information", rule: "short_body" };
  }
  const { total, density } = linkDensityOf(text);
  if (total < params.minContentChars) {
    return { ok: false, reject_reason: "low_information", rule: "short_body" };
  }
  if (density > params.maxLinkDensity) {
    return { ok: false, reject_reason: "navigational", rule: "link_density" };
  }
  const longest = longestProseRun(text);
  if (longest < params.minParagraphChars && listItemCount(text) >= 5) {
    return { ok: false, reject_reason: "navigational", rule: "thin_paragraphs" };
  }
  if (longest < params.minParagraphChars && density > params.maxLinkDensity * 0.7) {
    return { ok: false, reject_reason: "low_information", rule: "thin_paragraphs" };
  }
  return { ok: true };
}
