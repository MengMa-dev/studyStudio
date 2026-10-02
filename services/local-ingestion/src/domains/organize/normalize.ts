/** Name / heading normalization for alignment and patch section matching (07 ⑥). */

const FULLWIDTH_PAREN_OPEN = /（/g;
const FULLWIDTH_PAREN_CLOSE = /）/g;
const FULLWIDTH_SPACE = /\u3000/g;
const MULTI_SPACE = /\s+/g;

/** Collapse case, full/half-width parens & spaces for exact entry-name matching. */
export function normalizeEntryName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(FULLWIDTH_PAREN_OPEN, "(")
    .replace(FULLWIDTH_PAREN_CLOSE, ")")
    .replace(FULLWIDTH_SPACE, " ")
    .replace(MULTI_SPACE, " ")
    .trim()
    .toLowerCase();
}

/** Heading match key: strip leading markdown heading marks then normalize. */
export function normalizeHeading(heading: string): string {
  const stripped = heading.replace(/^#{1,6}\s*/, "").trim();
  return normalizeEntryName(stripped);
}

/** Ensure a section heading string starts with `## ` (default level-2). */
export function ensureHeadingMarks(heading: string, level = 2): string {
  if (/^#{1,6}\s/.test(heading)) return heading.trim();
  return `${"#".repeat(level)} ${heading.trim()}`;
}
