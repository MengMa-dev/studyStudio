import type { DatabaseSync } from "node:sqlite";
import { SEED_KINDS, sourceKindOf } from "@study-studio/shared";
import type { z } from "zod";
import { PROMPTS } from "../../ai/prompts/index.js";
import type { KnowledgeAlignInput, KnowledgeAlignOutput, KnowledgeExtractInput, KnowledgeExtractOutput } from "../../ai/prompts/schemas.draft.js";
import type { GenerativeAiTask } from "../../ai/types.js";
import { normalizeKind } from "../kb/queries.js";
import { PREFILTER_PARAMS, type EngagementLevel } from "./constants.js";
import { vectorRecall, type IndexContext } from "./kb-index.js";
import { callLlm, tryEmbed, type LlmContext } from "./llm.js";
import { normalizeEntryName } from "./normalize.js";
import { ENTRY_OWNER } from "./runtime-types.js";
import { categoryNames, findEntryByName, type EntryRecord, type OrganizeItem } from "./store.js";
import type { ScoredRelatedEntry } from "./types.js";
import {
  applySplitFixes,
  assembleResult,
  checkAlign,
  checkExtract,
  checkSplit,
  entrySections,
  verbatimRatio,
  VERBATIM_MIN_RATIO,
  type AlignKnown,
  type ProcessingResult,
  type SourceText,
  type SplitFix
} from "./verify.js";

/** ⑤ Knowledge Processing (17): extract (whole text) → V1 → concept recall → align → V2 → result. */

export const PROCESSING_PROMPT_VERSION = `organize@4(${PROMPTS.knowledge_extract.version}+${PROMPTS.knowledge_align.version})`;

const MAX_RELATED = 5;
const MAX_CANDIDATES = 10;
const CONCEPT_RECALL_K = 3;
const MAX_NEIGHBORS = 10;
const MAX_IGNORED_NAMES = 100;
const FRAGMENT_EXCERPT_CHARS = 300;
const SECTION_EXCERPT_CHARS = 200;

export type WorkEpisode = {
  episodeId: string;
  topic: string | null;
  learningGoal: string | null;
  relatedExploration: string[];
  uncertain: boolean;
};

/** One ⑤ run: a single item, or a conversation thread (turns ordered, the first is the anchor). */
export type WorkUnit = {
  key: string;
  items: OrganizeItem[];
  episode: WorkEpisode | null;
  engagement: EngagementLevel;
  adopt: boolean;
  path: "full" | "direct";
};

export type ProcessingContext = {
  db: DatabaseSync;
  llm: LlmContext;
  /** Entry vector index for per-concept recall; null disables it (name matching still applies). */
  indexCtx: IndexContext | null;
  requirement: string | null;
  fuzzyNotes: string[];
  ignoredNames: string[];
};

export function neighborEntries(db: DatabaseSync, relatedIds: string[]): Array<{ entry_id: string; name: string; aliases: string[] }> {
  if (relatedIds.length === 0) return [];
  const placeholders = relatedIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT e.id, e.name, e.aliases FROM kb_edges g
       JOIN kb_entries e ON e.id = CASE WHEN g.src IN (${placeholders}) THEN g.dst ELSE g.src END
       WHERE (g.src IN (${placeholders}) OR g.dst IN (${placeholders})) AND e.deleted_at IS NULL`
    )
    .all(...relatedIds, ...relatedIds, ...relatedIds) as Array<{ id: string; name: string; aliases: string | null }>;
  const exclude = new Set(relatedIds);
  return rows
    .filter((row) => !exclude.has(row.id))
    .slice(0, MAX_NEIGHBORS)
    .map((row) => {
      let aliases: string[] = [];
      try {
        aliases = row.aliases ? (JSON.parse(row.aliases) as string[]) : [];
      } catch {}
      return { entry_id: row.id, name: row.name, aliases };
    });
}

type Prompt<I, O> = {
  task: GenerativeAiTask;
  version: string;
  system: string;
  buildUserPrompt: (input: I) => string;
  outputSchema: (input: I) => z.ZodType<O> | z.ZodType;
};

function run<I, O>(llm: LlmContext, prompt: Prompt<I, O>, input: I): Promise<{ object: O; model: string }> {
  return callLlm(llm, {
    stage: "knowledge_processing",
    task: prompt.task,
    schema: prompt.outputSchema(input) as z.ZodType<O>,
    system: prompt.system,
    prompt: prompt.buildUserPrompt(input),
    promptVersion: prompt.version,
    input,
    traceStep: `knowledge_${(input as { step: string }).step}`
  });
}

/** Instructions come only from item notes, fuzzy notes and the organize requirement (entry notes never reach ⑤). */
export function buildExtractInput(ctx: ProcessingContext, unit: WorkUnit): KnowledgeExtractInput {
  const anchor = unit.items[0]!;
  const conversation = anchor.type === "conversation";
  return {
    step: "extract",
    item: { item_id: anchor.id, type: anchor.type, source_kind: sourceKindOf(anchor.type, anchor.url), title: anchor.title, url: anchor.url },
    text: conversation ? null : anchor.body,
    turns: conversation
      ? unit.items.map((item, index) => ({ turn_item_id: item.id, turn_index: index + 1, question: item.question ?? item.title, answer: item.body }))
      : null,
    user_highlights: unit.items.flatMap((item) => item.highlights),
    instructions: [
      ...unit.items.flatMap((item) => item.itemNotes.map((note) => ({ kind: "item_note" as const, text: note.text }))),
      ...ctx.fuzzyNotes.map((text) => ({ kind: "fuzzy_note" as const, text })),
      ...(ctx.requirement ? [{ kind: "requirement" as const, text: ctx.requirement }] : [])
    ],
    ignored_names: ctx.ignoredNames.slice(0, MAX_IGNORED_NAMES),
    feedback: null
  };
}

function sourceTexts(unit: WorkUnit): SourceText[] {
  const anchor = unit.items[0]!;
  return anchor.type === "conversation" ? unit.items.map((item) => ({ turnItemId: item.id, text: item.body })) : [{ turnItemId: null, text: anchor.body }];
}

type Extracted = { output: KnowledgeExtractOutput; model: string; retries: number; missing: string[]; rewritten: string[] };

/** V1: one feedback retry on rewritten / missing sections; keeps the result with fewer problems. */
async function extractVerified(ctx: ProcessingContext, unit: WorkUnit): Promise<Extracted> {
  const prompt = PROMPTS.knowledge_extract as Prompt<KnowledgeExtractInput, KnowledgeExtractOutput>;
  const input = buildExtractInput(ctx, unit);
  const sources = sourceTexts(unit);
  const summaryAllowed = input.instructions.length > 0;
  let { object: output, model } = await run(ctx.llm, prompt, input);
  let check = checkExtract(output, sources, summaryAllowed);
  let retries = 0;
  if (check.problems.length) {
    retries += 1;
    const retry = await run(ctx.llm, prompt, { ...input, feedback: check.problems });
    const retryCheck = checkExtract(retry.object, sources, summaryAllowed);
    if (retryCheck.problems.length < check.problems.length) {
      ({ object: output, model } = retry);
      check = retryCheck;
    }
  }
  return { output, model, retries, missing: check.missing, rewritten: check.rewritten };
}

/** ④ related entries ∪ per-concept name match / vector recall, best first. */
async function candidateEntries(
  ctx: ProcessingContext,
  concepts: string[],
  related: ScoredRelatedEntry[],
  entriesById: Map<string, EntryRecord>
): Promise<EntryRecord[]> {
  const scores = new Map<string, number>();
  const bump = (id: string, similarity: number) => {
    if (entriesById.has(id) && similarity > (scores.get(id) ?? -1)) scores.set(id, similarity);
  };
  for (const scored of related.slice(0, MAX_RELATED)) bump(scored.entry_id, scored.similarity);
  const entries = [...entriesById.values()];
  for (const concept of new Set(concepts)) {
    const hit = findEntryByName(entries, concept);
    if (hit) bump(hit.id, 1);
    if (!ctx.indexCtx) continue;
    const vector = await tryEmbed(ctx.llm, concept);
    if (!vector) continue;
    for (const [id, similarity] of vectorRecall(ctx.indexCtx, vector, [ENTRY_OWNER.name, ENTRY_OWNER.summary], CONCEPT_RECALL_K)) {
      if (similarity >= PREFILTER_PARAMS.similarityDiscardThreshold) bump(id, similarity);
    }
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([id]) => entriesById.get(id)!);
}

type NumberedFragment = Parameters<typeof assembleResult>[0][number];

function alignInput(ctx: ProcessingContext, unit: WorkUnit, fragments: NumberedFragment[], candidates: EntryRecord[]): KnowledgeAlignInput {
  const anchor = unit.items[0]!;
  return {
    step: "align",
    item: { item_id: anchor.id, type: anchor.type, source_kind: sourceKindOf(anchor.type, anchor.url), title: anchor.title },
    fragments: fragments.map((fragment) => ({
      fragment_id: fragment.id,
      concept: fragment.concept,
      heading: fragment.heading,
      excerpt: fragment.markdown.slice(0, FRAGMENT_EXCERPT_CHARS)
    })),
    candidate_entries: candidates.map((entry) => ({
      entry_id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
      kind: normalizeKind(entry.kind),
      summary: entry.summary ?? "",
      sections: entrySections(entry.body).map((section) => ({
        section_id: section.sectionId,
        heading: section.heading,
        excerpt: section.markdown.slice(0, SECTION_EXCERPT_CHARS)
      }))
    })),
    neighbor_entries: neighborEntries(
      ctx.db,
      candidates.map((entry) => entry.id)
    ),
    categories: categoryNames(ctx.db),
    kinds: [...SEED_KINDS],
    ignored_names: ctx.ignoredNames.slice(0, MAX_IGNORED_NAMES),
    feedback: null
  };
}

function alignKnown(input: KnowledgeAlignInput, ignoredNames: string[]): AlignKnown {
  const names = [...input.candidate_entries, ...input.neighbor_entries].flatMap((entry) => [entry.name, ...entry.aliases]);
  return {
    candidates: new Map(input.candidate_entries.map((entry) => [entry.entry_id, new Set(entry.sections.map((section) => section.section_id))])),
    neighborIds: new Set(input.neighbor_entries.map((entry) => entry.entry_id)),
    takenNames: new Set(names.map(normalizeEntryName)),
    ignoredNames: new Set(ignoredNames.map(normalizeEntryName))
  };
}

/** V2: one feedback retry on structural or split problems; structure still invalid → the unit fails, mis-splits left → merged. */
async function alignVerified(
  ctx: ProcessingContext,
  input: KnowledgeAlignInput,
  fragments: NumberedFragment[]
): Promise<{ output: KnowledgeAlignOutput; model: string; retries: number; splitFixes: SplitFix[] }> {
  const prompt = PROMPTS.knowledge_align as Prompt<KnowledgeAlignInput, KnowledgeAlignOutput>;
  const ids = input.fragments.map((fragment) => fragment.fragment_id);
  const known = alignKnown(input, ctx.ignoredNames);
  const first = await run(ctx.llm, prompt, input);
  const problems = [...checkAlign(first.object, ids, known), ...checkSplit(first.object, fragments).problems];
  if (problems.length === 0) return { output: first.object, model: first.model, retries: 0, splitFixes: [] };
  const retry = await run(ctx.llm, prompt, { ...input, feedback: problems });
  const remaining = checkAlign(retry.object, ids, known);
  if (remaining.length) throw new Error(`align invalid: ${remaining.join("; ")}`);
  const { fixes } = checkSplit(retry.object, fragments);
  return { output: applySplitFixes(retry.object, fixes), model: retry.model, retries: 1, splitFixes: fixes };
}

export type ProcessOutcome = {
  output: ProcessingResult;
  /** Per-step model outputs and check results, kept in `organize_results.output` for calibration. */
  raw: Record<string, unknown>;
  route: "llm";
  model: string | null;
};

export async function processUnit(
  ctx: ProcessingContext,
  unit: WorkUnit,
  related: ScoredRelatedEntry[],
  entriesById: Map<string, EntryRecord>
): Promise<ProcessOutcome> {
  const extracted = await extractVerified(ctx, unit);
  const raw: Record<string, unknown> = {
    extract: extracted.output,
    extract_retries: extracted.retries,
    missing_sections: extracted.missing,
    rewritten_fragments: extracted.rewritten
  };
  const turnIds = new Set(unit.items.map((item) => item.id));
  const fragments: NumberedFragment[] = extracted.output.fragments
    .filter((fragment) => fragment.markdown.trim())
    .map((fragment, index) => ({
      id: `f${index + 1}`,
      concept: fragment.concept.trim() || fragment.heading,
      heading: fragment.heading,
      markdown: fragment.markdown,
      summarized: fragment.summarized,
      turn_item_id: fragment.turn_item_id && turnIds.has(fragment.turn_item_id) ? fragment.turn_item_id : null
    }));
  if (fragments.length === 0) {
    if (unit.adopt) throw new Error("extract produced no fragments");
    return { output: { decision: "reject", reject_reason: "low_information" }, raw, route: "llm", model: extracted.model };
  }

  const candidates = await candidateEntries(
    ctx,
    fragments.map((fragment) => fragment.concept),
    related,
    entriesById
  );
  const aligned = await alignVerified(ctx, alignInput(ctx, unit, fragments, candidates), fragments);
  raw.align = aligned.output;
  raw.align_retries = aligned.retries;
  if (aligned.splitFixes.length) raw.split_merged = aligned.splitFixes;
  const coverage = checkCoverage(fragments, aligned.output, candidates);
  if (coverage.overridden.length) raw.coverage_overridden = coverage.overridden;
  return { output: assembleResult(fragments, coverage.output), raw, route: "llm", model: aligned.model };
}

/** align judges `covered_by` from excerpts only: a fragment whose text is not in that section is appended instead of dropped. */
function checkCoverage(fragments: NumberedFragment[], output: KnowledgeAlignOutput, candidates: EntryRecord[]) {
  const markdown = new Map(fragments.map((fragment) => [fragment.id, fragment.markdown]));
  const sections = new Map(candidates.map((entry) => [entry.id, new Map(entrySections(entry.body).map((section) => [section.sectionId, section.markdown]))]));
  const overridden: Array<{ fragment: string; section_id: string; ratio: number }> = [];
  const assignments = output.assignments.map((assignment) => {
    const section = assignment.covered_by ? sections.get(assignment.entry)?.get(assignment.covered_by) : undefined;
    const text = markdown.get(assignment.fragment_id);
    if (section === undefined || text === undefined) return assignment;
    const ratio = verbatimRatio(text, section);
    if (ratio >= VERBATIM_MIN_RATIO) return assignment;
    overridden.push({ fragment: assignment.fragment_id, section_id: assignment.covered_by!, ratio: Math.round(ratio * 100) / 100 });
    return { ...assignment, covered_by: null };
  });
  return { output: { ...output, assignments }, overridden };
}
