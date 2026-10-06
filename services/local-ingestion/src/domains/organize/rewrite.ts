import type { DatabaseSync } from "node:sqlite";
import { parseSections, sanitizeHeading, serializeSections, type KbSection } from "@study-studio/shared";
import { PROMPTS } from "../../ai/prompts/index.js";
import type { EntryRestructureInput, EntryRestructureOutput } from "../../ai/prompts/schemas.draft.js";
import { withTransaction } from "../../db/database.js";
import { normalizeKind } from "../kb/queries.js";
import { callLlm, type LlmContext } from "./llm.js";
import { categoryName, loadEntry, type EntryRecord } from "./store.js";
import { VERBATIM_MIN_RATIO, verbatimRatio } from "./verify.js";

/** ⑦ Entry restructure (17: replaces entry rewrite): reorder / rename / merge sections, text unchanged. */

export const REWRITE_PROMPT_VERSION = PROMPTS.entry_rewrite.version;

const SECTION_PREVIEW_CHARS = 1200;

/** Source deletion no longer marks entries stale (17); legacy `stale = 1` rows are still picked up by `staleEntryIds`. */
export function markStaleEntries(_db: DatabaseSync): number {
  return 0;
}

export function staleEntryIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM kb_entries WHERE deleted_at IS NULL AND stale = 1 ORDER BY updated_at").all() as Array<{ id: string }>).map(
    (row) => row.id
  );
}

type Trigger = EntryRestructureInput["trigger"];

/** Body sections with restructure ids: marked sections keep theirs, unmarked ones get `u_<index>`; the preamble is excluded. */
export function restructureSections(body: string): { preamble: KbSection | null; sections: Array<KbSection & { key: string }> } {
  const all = parseSections(body);
  const preamble = all[0]?.heading === null ? all[0] : null;
  const sections = all.slice(preamble ? 1 : 0).map((section, index) => ({ ...section, key: section.id ?? `u_${index}` }));
  return { preamble, sections };
}

function sourceTitles(db: DatabaseSync, itemIds: string[]): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT i.id, COALESCE(i.title, c.question, i.url, i.id) AS title FROM items i LEFT JOIN item_contents c ON c.item_id = i.id
              WHERE i.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(itemIds)) as Array<{ id: string; title: string }>;
  return new Map(rows.map((row) => [row.id, row.title]));
}

export function buildRestructureInput(db: DatabaseSync, entry: EntryRecord, trigger: Trigger, requirement: string | null): EntryRestructureInput {
  const { sections } = restructureSections(entry.body);
  const titles = sourceTitles(db, [...new Set(sections.flatMap((section) => section.sourceItemIds))]);
  return {
    entry: {
      entry_id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      kind: normalizeKind(entry.kind),
      category: categoryName(db, entry.categoryId) ?? "",
      summary: entry.summary ?? "",
      patch_count: entry.patchCount
    },
    trigger,
    sections: sections.map((section) => ({
      section_id: section.key,
      heading: section.heading ?? "",
      markdown: section.markdown.length > SECTION_PREVIEW_CHARS ? `${section.markdown.slice(0, SECTION_PREVIEW_CHARS)}…（截断）` : section.markdown,
      sources: section.sourceItemIds.map((id) => ({ item_id: id, title: titles.get(id) ?? id })),
      mergeable: section.id !== null
    })),
    requirement,
    feedback: null
  };
}

/** Structural problems of a restructure plan (empty = valid). */
export function restructureProblems(input: EntryRestructureInput, output: EntryRestructureOutput): string[] {
  const problems: string[] = [];
  const ids = new Set(input.sections.map((section) => section.section_id));
  const mergeable = new Set(input.sections.filter((section) => section.mergeable).map((section) => section.section_id));
  const dropped = new Set<string>();
  const keeps = new Set<string>();
  for (const group of output.merge) {
    for (const id of [group.keep, ...group.drop]) {
      if (!ids.has(id)) problems.push(`merge 中的 ${id} 不存在`);
      else if (!mergeable.has(id)) problems.push(`${id} 不可合并`);
    }
    keeps.add(group.keep);
    for (const id of group.drop) {
      if (id === group.keep || dropped.has(id)) problems.push(`${id} 在 merge 中重复出现`);
      dropped.add(id);
    }
  }
  for (const id of keeps) if (dropped.has(id)) problems.push(`${id} 既是 keep 又被 drop`);
  const seen = new Set<string>();
  for (const id of output.order) {
    if (!ids.has(id)) problems.push(`order 中的 ${id} 不存在`);
    else if (dropped.has(id)) problems.push(`${id} 已被合并删除，不应出现在 order 中`);
    else if (seen.has(id)) problems.push(`${id} 在 order 中重复`);
    seen.add(id);
  }
  const missing = [...ids].filter((id) => !seen.has(id) && !dropped.has(id));
  if (missing.length) problems.push(`order 缺少：${missing.join("、")}`);
  for (const item of output.headings) if (!ids.has(item.section_id)) problems.push(`headings 中的 ${item.section_id} 不存在`);
  return problems;
}

export type SkippedMerge = { keep: string; drop: string; ratio: number };

/**
 * Reassembles the body by id: text untouched, renamed headings applied, merged sources moved into the kept section.
 * The plan only saw previews, so a drop whose full text is not contained in the kept section stays as its own section after it.
 */
export function applyRestructure(
  body: string,
  output: EntryRestructureOutput
): { body: string; reanchor: Array<{ from: string; to: string }>; skippedMerges: SkippedMerge[] } {
  const { preamble, sections } = restructureSections(body);
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const headings = new Map(output.headings.map((item) => [item.section_id, sanitizeHeading(item.heading.replace(/^#+\s*/, ""))]));
  const reanchor: Array<{ from: string; to: string }> = [];
  const skippedMerges: SkippedMerge[] = [];
  for (const group of output.merge) {
    const keep = byKey.get(group.keep)!;
    for (const id of group.drop) {
      const drop = byKey.get(id)!;
      const ratio = verbatimRatio(drop.markdown, keep.markdown);
      if (ratio < VERBATIM_MIN_RATIO) {
        skippedMerges.push({ keep: group.keep, drop: id, ratio: Math.round(ratio * 100) / 100 });
        continue;
      }
      keep.sourceItemIds = [...new Set([...keep.sourceItemIds, ...drop.sourceItemIds])];
      reanchor.push({ from: id, to: group.keep });
    }
  }
  const order = output.order.flatMap((key) => [key, ...skippedMerges.filter((skip) => skip.keep === key).map((skip) => skip.drop)]);
  const ordered = order.map((key) => {
    const { key: _key, ...section } = byKey.get(key)!;
    return { ...section, heading: headings.get(key) || section.heading };
  });
  return { body: serializeSections(preamble ? [preamble, ...ordered] : ordered), reanchor, skippedMerges };
}

export type RewriteOutcome = { status: "rewritten" | "orphaned" | "missing"; entry: EntryRecord | null; skippedMerges?: SkippedMerge[] };

export async function rewriteEntry(
  db: DatabaseSync,
  llm: LlmContext,
  entryId: string,
  trigger: Trigger,
  requirement: string | null,
  now: string
): Promise<RewriteOutcome> {
  const entry = loadEntry(db, entryId);
  if (!entry) return { status: "missing", entry: null };
  const input = buildRestructureInput(db, entry, trigger, requirement);
  if (input.sections.length < 2) {
    db.prepare("UPDATE kb_entries SET patch_count = 0, stale = 0 WHERE id = ?").run(entryId);
    return { status: "rewritten", entry: loadEntry(db, entryId) };
  }
  const prompt = PROMPTS.entry_rewrite;
  const call = async (payload: EntryRestructureInput) =>
    (
      await callLlm(llm, {
        stage: "entry_rewrite",
        task: prompt.task,
        schema: prompt.outputSchema(payload),
        system: prompt.system,
        prompt: prompt.buildUserPrompt(payload),
        promptVersion: prompt.version,
        input: payload
      })
    ).object;
  let object = await call(input);
  let problems = restructureProblems(input, object);
  if (problems.length) {
    object = await call({ ...input, feedback: problems });
    problems = restructureProblems(input, object);
    if (problems.length) throw new Error(`entry_restructure_invalid: ${problems.join("；")}`);
  }
  let skippedMerges: SkippedMerge[] = [];
  withTransaction(db, () => {
    const current = loadEntry(db, entryId);
    if (!current) return;
    if (current.body !== entry.body) throw new Error("entry_restructure_conflict: 词条正文已被修改");
    const applied = applyRestructure(current.body, object);
    skippedMerges = applied.skippedMerges;
    const summary = current.userEdited ? current.summary : object.summary.trim() || current.summary;
    db.prepare(
      `UPDATE kb_entries SET body_markdown = ?, summary = ?, patch_count = 0, stale = 0, dirty = CASE WHEN user_edited = 1 THEN dirty ELSE 0 END, updated_at = ?
       WHERE id = ?`
    ).run(applied.body, summary, now, entryId);
    const reanchor = db.prepare("UPDATE notes SET anchor = ? WHERE scope = 'entry' AND target_id = ? AND anchor = ?");
    for (const move of applied.reanchor) reanchor.run(move.to, entryId, move.from);
  });
  return { status: "rewritten", entry: loadEntry(db, entryId), skippedMerges };
}
