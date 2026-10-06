/**
 * Entry body sections (17): an organized section is a `## heading` followed by a marker line
 * `<!-- section:<id> src:<itemId>,<itemId> -->`. `## ` lines outside code fences are the only section
 * boundaries, so written fragments keep their own headings at level 3+ (`demoteHeadings`).
 */

export type KbSection = {
  /** null for hand-written / legacy sections without a marker. */
  id: string | null;
  /** `## ` heading text without the hashes; null for the preamble before the first heading. */
  heading: string | null;
  sourceItemIds: string[];
  /** Section content without the heading and marker lines. */
  markdown: string;
};

const MARKER = /^<!--\s*section:(\S+)(?:\s+src:(\S*))?\s*-->\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const SECTION_HEADING = /^##\s+(.+?)(?:\s+#+)?\s*$/;
const ANY_HEADING = /^(#{1,6})(\s+.*)$/;
const HEADING_MAX = 120;

function marker(id: string, sources: string[]): string {
  return `<!-- section:${id} src:${sources.join(",")} -->`;
}

/** Fence state after `line`: the open fence run (e.g. "```"), or null outside fences (CommonMark closing rule). */
export function nextFence(open: string | null, line: string): string | null {
  const match = FENCE.exec(line);
  if (!match) return open;
  const run = match[1]!;
  if (open === null) return run;
  return run[0] === open[0] && run.length >= open.length && !match[2]!.trim() ? null : open;
}

/** Appends a closing fence when the markdown ends inside an unclosed code fence. */
export function closeFences(markdown: string): string {
  const open = markdown.split("\n").reduce<string | null>(nextFence, null);
  return open === null ? markdown : `${markdown}\n${open}`;
}

/** Single-line heading text that cannot forge a marker line. */
export function sanitizeHeading(heading: string): string {
  let text = heading;
  while (/<!--|-->/.test(text)) text = text.replace(/<!--|-->/g, "");
  return text.replace(/\s+/g, " ").trim().slice(0, HEADING_MAX).trim();
}

export function newSectionId(): string {
  return `s_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
}

export function parseSections(body: string): KbSection[] {
  const sections: KbSection[] = [];
  let current: KbSection & { lines: string[] } = { id: null, heading: null, sourceItemIds: [], markdown: "", lines: [] };
  let fence: string | null = null;
  let expectMarker = false;
  const push = () => {
    const markdown = current.lines.join("\n").replace(/^\n+|\s+$/g, "");
    if (current.heading !== null || markdown) sections.push({ id: current.id, heading: current.heading, sourceItemIds: current.sourceItemIds, markdown });
  };
  for (const line of body.split("\n")) {
    if (fence === null && expectMarker) {
      expectMarker = false;
      const match = MARKER.exec(line.trim());
      if (match) {
        current.id = match[1]!;
        current.sourceItemIds = (match[2] ?? "").split(",").filter(Boolean);
        continue;
      }
    }
    const wasFenced = fence !== null;
    fence = nextFence(fence, line);
    const heading = wasFenced || fence !== null ? null : SECTION_HEADING.exec(line);
    if (heading) {
      push();
      current = { id: null, heading: heading[1]!, sourceItemIds: [], markdown: "", lines: [] };
      expectMarker = true;
      continue;
    }
    current.lines.push(line);
  }
  push();
  return sections;
}

export function serializeSections(sections: KbSection[]): string {
  return sections
    .map((section) => {
      const head = section.heading === null ? [] : [`## ${sanitizeHeading(section.heading) || "未命名"}`, ...(section.id ? [marker(section.id, section.sourceItemIds)] : [])];
      return [...head, section.markdown].filter((part, index) => part !== "" || index < head.length).join("\n");
    })
    .join("\n\n")
    .trim();
}

/** Body for rendering / search: marker lines removed. */
export function stripSectionMarkers(body: string): string {
  return serializeSections(parseSections(body).map((section) => ({ ...section, id: null })));
}

/** Shifts headings so the shallowest one is level 3 (code fences untouched). */
export function demoteHeadings(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  const outside = lines.map((line) => {
    const wasFenced = fence !== null;
    fence = nextFence(fence, line);
    return !wasFenced && fence === null;
  });
  let min = 7;
  lines.forEach((line, index) => {
    const match = outside[index] ? ANY_HEADING.exec(line) : null;
    if (match) min = Math.min(min, match[1]!.length);
  });
  if (min >= 3) return markdown;
  const shift = 3 - min;
  return lines
    .map((line, index) => {
      const match = outside[index] ? ANY_HEADING.exec(line) : null;
      return match ? `${"#".repeat(Math.min(6, match[1]!.length + shift))}${match[2]}` : line;
    })
    .join("\n");
}

export type NewSection = { heading: string; markdown: string; sourceItemIds: string[] };

/** Appends marked sections; returns the new body and the created section ids (input order). */
export function appendSections(body: string, added: NewSection[]): { body: string; ids: string[] } {
  const sections = parseSections(body);
  const ids = added.map(() => newSectionId());
  added.forEach((section, index) =>
    sections.push({
      id: ids[index]!,
      heading: sanitizeHeading(section.heading.replace(/^\s*#+\s*/, "")) || "未命名",
      sourceItemIds: [...new Set(section.sourceItemIds)],
      markdown: closeFences(demoteHeadings(section.markdown.trim()))
    })
  );
  return { body: serializeSections(sections), ids };
}

/** Adds sources to a section; returns null when the section id does not exist. */
export function attachSectionSources(body: string, sectionId: string, itemIds: string[]): string | null {
  const sections = parseSections(body);
  const target = sections.find((section) => section.id === sectionId);
  if (!target) return null;
  target.sourceItemIds = [...new Set([...target.sourceItemIds, ...itemIds])];
  return serializeSections(sections);
}

/** Removes a source item: sections only from it are deleted, shared sections drop it. */
export function removeSectionSource(body: string, itemId: string): { body: string; removedSectionIds: string[] } {
  const removedSectionIds: string[] = [];
  const kept = parseSections(body).filter((section) => {
    if (!section.id || !section.sourceItemIds.includes(itemId)) return true;
    section.sourceItemIds = section.sourceItemIds.filter((id) => id !== itemId);
    if (section.sourceItemIds.length > 0) return true;
    removedSectionIds.push(section.id);
    return false;
  });
  return { body: serializeSections(kept), removedSectionIds };
}
