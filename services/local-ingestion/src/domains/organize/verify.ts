import { nextFence, parseSections } from "@study-studio/shared";
import type { KnowledgeAlignOutput, KnowledgeExtractOutput } from "../../ai/prompts/schemas.draft.js";
import { normalizeEntryName, normalizeHeading } from "./normalize.js";

/** ⑤ (17) code checks: V1 extract (verbatim ratio, section completeness), V2 align (structure), result assembly. */

export const VERBATIM_MIN_RATIO = 0.85;
const MIN_SECTION_CHARS = 50;
/** A section without a matching `source_section` still counts when this share of its bigrams is in the fragments. */
const SECTION_CONTENT_RATIO = 0.6;

export type ExtractFragment = KnowledgeExtractOutput["fragments"][number];

/** Original text the fragments are cut from: a document, or one conversation turn (`turnItemId`). */
export type SourceText = { turnItemId: string | null; text: string };

const squash = (text: string) => text.replace(/[\s#*_>`|~-]+/g, "");

function bigrams(text: string): Set<string> {
  const chars = [...squash(text)];
  const out = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) out.add(chars[index]! + chars[index + 1]!);
  return out;
}

function ratioIn(part: Set<string>, whole: Set<string>): number {
  if (part.size === 0) return 1;
  let hit = 0;
  for (const gram of part) if (whole.has(gram)) hit += 1;
  return hit / part.size;
}

/** Share of the fragment's character bigrams found in the source (1 = verbatim). */
export function verbatimRatio(markdown: string, source: string): number {
  return ratioIn(bigrams(markdown), bigrams(source));
}

const headingKey = (heading: string) => normalizeHeading(heading).replace(/[*_`]/g, "").replace(/[:：]$/, "").trim();

type SourceSection = { turnItemId: string | null; heading: string | null; body: string };

/** Splits by markdown headings of any level (code fences respected). */
export function sourceSections(sources: SourceText[]): SourceSection[] {
  const out: SourceSection[] = [];
  for (const source of sources) {
    let current: SourceSection = { turnItemId: source.turnItemId, heading: null, body: "" };
    let fence: string | null = null;
    for (const line of source.text.split("\n")) {
      fence = nextFence(fence, line);
      if (fence === null && /^#{1,6}\s+\S/.test(line)) {
        out.push(current);
        current = { turnItemId: source.turnItemId, heading: line.trim(), body: "" };
      } else current.body += `${line}\n`;
    }
    out.push(current);
  }
  return out.filter((section) => squash(section.body).length >= MIN_SECTION_CHARS);
}

export type ExtractCheck = { problems: string[]; rewritten: string[]; missing: string[] };

/**
 * V1: rewritten fragments (bigram ratio below VERBATIM_MIN_RATIO) and long source sections neither cut nor removed.
 * `summarized` only exempts a fragment when the input carries instructions (`summaryAllowed`).
 */
export function checkExtract(output: KnowledgeExtractOutput, sources: SourceText[], summaryAllowed: boolean): ExtractCheck {
  const whole = bigrams(sources.map((source) => source.text).join("\n"));
  const rewritten: string[] = [];
  const problems: string[] = [];
  output.fragments.forEach((fragment, index) => {
    if (fragment.summarized && summaryAllowed) return;
    const score = ratioIn(bigrams(fragment.markdown), whole);
    if (score >= VERBATIM_MIN_RATIO) return;
    rewritten.push(fragment.heading);
    const label = `片段 ${index + 1}「${fragment.heading}」与原文的一致率只有 ${Math.round(score * 100)}%`;
    problems.push(
      fragment.summarized
        ? `${label}，但没有任何指令要求摘要：不得置 summarized=true，请逐字保留原文措辞，只删除废话`
        : `${label}，疑似改写：请逐字保留原文措辞，只删除废话；按指令只留摘要的部分须置 summarized=true`
    );
  });

  const sameTurn = (turnItemId: string | null, section: SourceSection) => !turnItemId || !section.turnItemId || turnItemId === section.turnItemId;
  const sectionMatches = (sourceSection: string | null, section: SourceSection) =>
    sourceSection === null || section.heading === null ? sourceSection === null && section.heading === null : headingKey(sourceSection) === headingKey(section.heading);
  const missing: string[] = [];
  for (const section of sourceSections(sources)) {
    const fragments = output.fragments.filter((fragment) => sameTurn(fragment.turn_item_id, section));
    if (fragments.some((fragment) => sectionMatches(fragment.source_section, section))) continue;
    if (output.removed.some((removed) => sectionMatches(removed.source_section, section))) continue;
    if (ratioIn(bigrams(section.body), bigrams(fragments.map((fragment) => fragment.markdown).join("\n"))) >= SECTION_CONTENT_RATIO) continue;
    const label = section.heading ?? `${section.body.trim().slice(0, 30)}…`;
    missing.push(label);
    problems.push(`原文章节「${label}」既没有片段（source_section）引用，也不在 removed 中：请输出该章节的原文片段，或在 removed 中说明剔除原因`);
  }
  return { problems, rewritten, missing };
}

/** Entry sections as shown to align: marked sections keep their id, unmarked (hand-written / legacy) ones get `u_<index>`. */
export function entrySections(body: string): Array<{ sectionId: string; heading: string | null; markdown: string; marked: boolean; sourceItemIds: string[] }> {
  return parseSections(body).map((section, index) => ({
    sectionId: section.id ?? `u_${index}`,
    heading: section.heading,
    markdown: section.markdown,
    marked: section.id !== null,
    sourceItemIds: section.sourceItemIds
  }));
}

export type AlignKnown = {
  /** Candidate entry id → its section ids (from `entrySections`). */
  candidates: Map<string, Set<string>>;
  neighborIds: Set<string>;
  /** Normalized names / aliases of candidates and neighbors. */
  takenNames: Set<string>;
  ignoredNames: Set<string>;
};

/** V2: every fragment assigned exactly once to a known entry / declared new key; `covered_by` is a section of that entry. */
export function checkAlign(output: KnowledgeAlignOutput, fragmentIds: string[], known: AlignKnown): string[] {
  const problems: string[] = [];
  const keys = new Map(output.new_entries.map((entry) => [entry.key, entry]));
  const counts = new Map<string, number>();
  for (const assignment of output.assignments) {
    counts.set(assignment.fragment_id, (counts.get(assignment.fragment_id) ?? 0) + 1);
    if (!fragmentIds.includes(assignment.fragment_id)) {
      problems.push(`assignments 引用了不存在的片段 ${assignment.fragment_id}`);
      continue;
    }
    const sections = known.candidates.get(assignment.entry);
    if (!sections && !known.neighborIds.has(assignment.entry) && !keys.has(assignment.entry)) {
      problems.push(`片段 ${assignment.fragment_id} 的 entry「${assignment.entry}」既不是候选 / 邻居词条 id，也不是 new_entries 中的 key`);
      continue;
    }
    if (assignment.covered_by && !sections?.has(assignment.covered_by)) {
      problems.push(`片段 ${assignment.fragment_id} 的 covered_by「${assignment.covered_by}」不是词条「${assignment.entry}」的章节 id；没有完整覆盖时应为 null`);
    }
  }
  const unassigned = fragmentIds.filter((id) => !counts.has(id));
  if (unassigned.length) problems.push(`以下片段未分配：${unassigned.join("、")}`);
  const repeated = [...counts].filter(([id, count]) => count > 1 && fragmentIds.includes(id)).map(([id]) => id);
  if (repeated.length) problems.push(`以下片段被分配了多次，每个片段只能分配一次：${repeated.join("、")}`);
  const used = new Set(output.assignments.map((assignment) => assignment.entry));
  for (const entry of output.new_entries) {
    if (!used.has(entry.key)) continue;
    const names = [entry.name, ...entry.aliases].map(normalizeEntryName);
    if (names.some((name) => known.ignoredNames.has(name))) problems.push(`新词条「${entry.name}」在 ignored_names 中，不得新建`);
    else if (names.some((name) => known.takenNames.has(name))) problems.push(`新词条「${entry.name}」与已有词条重名，应分配给该已有词条`);
  }
  return problems;
}

const MIN_SPLIT_CHARS = 800;
const MAX_ENTRY_NAME_CHARS = 40;
const PROPOSITION_NAME = /不需要|不要|应该|必须|如何|为什么|怎么|是否|吗|[？?]/;

export type SplitFix = { from: string; into: string; reason: "sandwiched" | "too_small" };

/**
 * Split quality (17): a new entry holding one fragment between two fragments of the same entry, or a small
 * `part_of` child of another new entry, is a mis-split. Fed back once, then merged by `applySplitFixes`.
 */
export function checkSplit(output: KnowledgeAlignOutput, fragments: Array<{ id: string; markdown: string }>): { problems: string[]; fixes: SplitFix[] } {
  const entryOf = new Map(output.assignments.map((assignment) => [assignment.fragment_id, assignment.entry]));
  const order = fragments.map((fragment) => entryOf.get(fragment.id));
  const keyByName = new Map(output.new_entries.map((entry) => [normalizeEntryName(entry.name), entry.key]));
  const problems: string[] = [];
  const fixes: SplitFix[] = [];
  for (const entry of output.new_entries) {
    const own = fragments.filter((fragment) => entryOf.get(fragment.id) === entry.key);
    if (own.length === 0) continue;
    if (entry.name.length > MAX_ENTRY_NAME_CHARS || PROPOSITION_NAME.test(entry.name)) {
      problems.push(`新词条「${entry.name}」不是词条级名词（过长或是一句论断）：改用名词短语，或并入它所属的词条`);
    }
    let fix: SplitFix | undefined;
    if (own.length === 1) {
      const index = order.indexOf(entry.key);
      const before = order[index - 1];
      if (before && before === order[index + 1]) fix = { from: entry.key, into: before, reason: "sandwiched" };
    }
    if (!fix && own.length < 2 && own.reduce((sum, fragment) => sum + fragment.markdown.length, 0) < MIN_SPLIT_CHARS) {
      const parent = output.relations.find(
        (relation) => relation.type === "part_of" && keyByName.get(normalizeEntryName(relation.from)) === entry.key && keyByName.has(normalizeEntryName(relation.to))
      );
      const into = parent && keyByName.get(normalizeEntryName(parent.to));
      if (into && into !== entry.key) fix = { from: entry.key, into, reason: "too_small" };
    }
    if (!fix) continue;
    fixes.push(fix);
    problems.push(
      fix.reason === "sandwiched"
        ? `新词条「${entry.name}」只有一个片段且前后片段都属于「${fix.into}」：它是该词条的组成部分，应并入「${fix.into}」`
        : `新词条「${entry.name}」内容过少（单个片段、不足 ${MIN_SPLIT_CHARS} 字），不足以独立成条，应并入「${fix.into}」`
    );
  }
  return { problems, fixes };
}

export function applySplitFixes(output: KnowledgeAlignOutput, fixes: SplitFix[]): KnowledgeAlignOutput {
  if (fixes.length === 0) return output;
  const into = new Map(fixes.map((fix) => [fix.from, fix.into]));
  const target = (key: string) => {
    let current = key;
    for (let hops = 0; into.has(current) && hops < fixes.length; hops += 1) current = into.get(current)!;
    return current;
  };
  const dropped = new Set(output.new_entries.filter((entry) => into.has(entry.key)).map((entry) => normalizeEntryName(entry.name)));
  return {
    ...output,
    assignments: output.assignments.map((assignment) => (into.has(assignment.entry) ? { ...assignment, entry: target(assignment.entry), covered_by: null } : assignment)),
    new_entries: output.new_entries.filter((entry) => !into.has(entry.key)),
    relations: output.relations.filter((relation) => !dropped.has(normalizeEntryName(relation.from)) && !dropped.has(normalizeEntryName(relation.to)))
  };
}

export type AlignedFragment = {
  id: string;
  concept: string;
  heading: string;
  markdown: string;
  summarized: boolean;
  turn_item_id: string | null;
  /** Entry id or a `new_entries` key. */
  entry: string;
  covered_by: string | null;
};

export type ProcessingResult =
  | { decision: "reject"; reject_reason: "low_information" }
  | {
      decision: "new" | "supplement" | "duplicate";
      fragments: AlignedFragment[];
      new_entries: KnowledgeAlignOutput["new_entries"];
      relations: KnowledgeAlignOutput["relations"];
      item_summary: string;
      item_points: string[];
    };

/** Decision (17): all covered → duplicate; any new entry → new; otherwise supplement. */
export function assembleResult(fragments: Array<Omit<AlignedFragment, "entry" | "covered_by">>, output: KnowledgeAlignOutput): ProcessingResult {
  if (fragments.length === 0) return { decision: "reject", reject_reason: "low_information" };
  const byId = new Map(output.assignments.map((assignment) => [assignment.fragment_id, assignment]));
  const keys = new Set(output.new_entries.map((entry) => entry.key));
  const aligned = fragments.map((fragment) => {
    const assignment = byId.get(fragment.id)!;
    return { ...fragment, entry: assignment.entry, covered_by: keys.has(assignment.entry) ? null : assignment.covered_by };
  });
  const decision = aligned.every((fragment) => fragment.covered_by) ? "duplicate" : aligned.some((fragment) => keys.has(fragment.entry)) ? "new" : "supplement";
  return {
    decision,
    fragments: aligned,
    new_entries: output.new_entries,
    relations: output.relations,
    item_summary: output.item_summary,
    item_points: output.item_points
  };
}
