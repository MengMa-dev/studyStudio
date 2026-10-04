import type { DatabaseSync } from "node:sqlite";
import { sourceKindOf } from "@study-studio/shared";
import type { z } from "zod";
import { PROMPTS } from "../../ai/prompts/index.js";
import type {
  KnowledgeComposeInput,
  KnowledgeComposeOutput,
  KnowledgeExtractInput,
  KnowledgeExtractOutput,
  KnowledgeProcessingOutput,
  KnowledgeTriageInput,
  KnowledgeTriageOutput
} from "../../ai/prompts/schemas.draft.js";
import type { GenerativeAiTask } from "../../ai/types.js";
import { estimateTokens } from "../../search/chunk.js";
import { normalizeKind } from "../kb/queries.js";
import { annotateExposure, chunkUnit, type ContentChunk } from "./chunk.js";
import { PREFILTER_PARAMS, type EngagementLevel } from "./constants.js";
import { assembleResult, missingFeedback, missingPoints, validateCompose, type KnowledgePoint } from "./coverage.js";
import { vectorRecall, type IndexContext } from "./kb-index.js";
import { kindVocabulary } from "./kinds.js";
import { callLlm, isUsageLimitError, tryEmbed, type LlmContext } from "./llm.js";
import { normalizeHeading } from "./normalize.js";
import { applyValueScoreFallback } from "./postprocess.js";
import { headByTokens } from "./retrieve.js";
import { ENTRY_OWNER } from "./runtime-types.js";
import { categoryNames, findEntryByName, outlineOf, type EntryRecord, type OrganizeItem } from "./store.js";
import type { ScoredRelatedEntry, ValueScoreFallbackResult } from "./types.js";

/** ⑤ Knowledge Processing (15): S1 triage → chunk → S2 extract → concept recall → S3+S4 compose → S5 coverage. */

export const PROCESSING_PROMPT_VERSION = `organize@3(${PROMPTS.knowledge_triage.version}+${PROMPTS.knowledge_extract.version}+${PROMPTS.knowledge_compose.version})`;

const EXCERPT_TOKEN_BUDGET = 3_000;
const TRIAGE_ANSWER_HEAD_TOKENS = 400;
const MAX_RELATED = 5;
const MAX_CANDIDATES = 10;
const CONCEPT_RECALL_K = 3;
const CANDIDATE_BODY_BUDGET = 12_000;
const EXTRACT_CONCURRENCY = 3;
const MAX_NEIGHBORS = 10;
const MAX_IGNORED_NAMES = 100;

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
  profile: { role: string; learning_focus: string[] };
  requirement: string | null;
  fuzzyNotes: string[];
  ignoredNames: string[];
};

type Section = { heading: string | null; lines: string[] };

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ heading: null, lines: [] }];
  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s+\S/.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  return sections.filter((section) => section.heading !== null || section.lines.join("").trim());
}

function sectionText(section: Section): string {
  return [section.heading, ...section.lines]
    .filter((line) => line !== null)
    .join("\n")
    .trim();
}

function takeTokens(parts: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const part of parts) {
    const tokens = estimateTokens(part);
    if (used + tokens > budget) {
      if (out.length === 0) out.push(part.slice(0, budget * 2));
      break;
    }
    out.push(part);
    used += tokens;
  }
  return out.join("\n\n");
}

function exposedSeconds(section: Section, item: OrganizeItem): number {
  if (!section.heading) return 0;
  const key = normalizeHeading(section.heading);
  return item.exposure.find((row) => row.heading && normalizeHeading(row.heading) === key)?.exposed_seconds ?? 0;
}

/** S1 excerpt: sections around highlights → most exposed sections → document head (~3k tokens). */
export function buildExcerpt(item: OrganizeItem, budget = EXCERPT_TOKEN_BUDGET): string {
  const sections = splitSections(item.body);
  const picked: Section[] = [];
  const add = (section: Section) => {
    if (!picked.includes(section)) picked.push(section);
  };
  for (const highlight of item.highlights) {
    const probe = highlight.slice(0, 40);
    const hit = sections.find((section) => sectionText(section).includes(probe));
    if (hit) add(hit);
  }
  [...sections]
    .sort((a, b) => exposedSeconds(b, item) - exposedSeconds(a, item))
    .forEach((section) => {
      if (exposedSeconds(section, item) > 0) add(section);
    });
  sections.forEach(add);
  return takeTokens(
    picked.map((section) => annotateExposure(sectionText(section), item.exposure)),
    budget
  );
}

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

function round(value: number): number {
  return Math.round(value * 100) / 100;
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
    input
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!);
      }
    })
  );
  return out;
}

/** One retry for transient failures; usage limits and aborts propagate immediately. */
async function retryOnce<T>(llm: LlmContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUsageLimitError(error) || llm.signal?.aborted) throw error;
    return fn();
  }
}

const normalizeSpace = (text: string) => text.replace(/\s+/g, " ").trim();

function hasUserMarks(unit: WorkUnit): boolean {
  return unit.items.some((item) => item.highlights.length > 0 || item.itemNotes.length > 0);
}

export function buildTriageInput(ctx: ProcessingContext, unit: WorkUnit, related: ScoredRelatedEntry[], entriesById: Map<string, EntryRecord>): KnowledgeTriageInput {
  const anchor = unit.items[0]!;
  const conversation = anchor.type === "conversation";
  const annotated = conversation ? "" : annotateExposure(anchor.body, anchor.exposure);
  return {
    step: "triage",
    mode: unit.adopt ? "adopt" : "normal",
    episode: unit.episode
      ? { episode_id: unit.episode.episodeId, topic: unit.episode.topic ?? "", learning_goal: unit.episode.learningGoal ?? "", uncertain: unit.episode.uncertain }
      : null,
    learner_profile: ctx.profile,
    item: {
      item_id: anchor.id,
      type: anchor.type,
      source_kind: sourceKindOf(anchor.type, anchor.url),
      title: anchor.title,
      ...(anchor.url ? { url: anchor.url } : {}),
      outline: conversation ? [] : outlineOf(anchor.body),
      ...(conversation
        ? {
            turns: unit.items.map((item, index) => ({
              turn_item_id: item.id,
              turn_index: index + 1,
              question: item.question ?? item.title,
              answer: headByTokens(item.body, TRIAGE_ANSWER_HEAD_TOKENS)
            }))
          }
        : { excerpt: estimateTokens(annotated) <= EXCERPT_TOKEN_BUDGET ? annotated : buildExcerpt(anchor) }),
      user_highlights: unit.items.flatMap((item) => item.highlights),
      user_note: unit.items.flatMap((item) => item.itemNotes.map((note) => note.text)).join("\n") || null,
      fuzzy_notes: ctx.fuzzyNotes,
      requirement: ctx.requirement,
      engagement: unit.engagement
    },
    related_entries: related
      .slice(0, MAX_RELATED)
      .filter((scored) => entriesById.has(scored.entry_id))
      .map((scored) => {
        const entry = entriesById.get(scored.entry_id)!;
        return {
          entry_id: entry.id,
          name: entry.name,
          aliases: entry.aliases,
          kind: normalizeKind(entry.kind),
          summary: entry.summary ?? "",
          similarity: round(scored.similarity),
          recency_relevance: round(scored.recency_relevance),
          outline: outlineOf(entry.body)
        };
      }),
    ignored_names: ctx.ignoredNames.slice(0, MAX_IGNORED_NAMES)
  };
}

function extractInput(unit: WorkUnit, chunk: ContentChunk, thesis: string, userFocus: string[]): KnowledgeExtractInput {
  const anchor = unit.items[0]!;
  return {
    step: "extract",
    item: { item_id: anchor.id, type: anchor.type, source_kind: sourceKindOf(anchor.type, anchor.url), title: anchor.title },
    thesis,
    user_focus: userFocus,
    user_highlights: unit.items.flatMap((item) => item.highlights),
    user_note: unit.items.flatMap((item) => item.itemNotes.map((note) => note.text)).join("\n") || null,
    chunk
  };
}

/** Numbers points p1…pn in chunk order; fills turn questions; highlighted quotes become core. */
export function collectPoints(unit: WorkUnit, outputs: KnowledgeExtractOutput[]): KnowledgePoint[] {
  const questions = new Map(unit.items.map((item) => [item.id, item.question ?? item.title]));
  const highlights = unit.items.flatMap((item) => item.highlights).map(normalizeSpace).filter(Boolean);
  const marked = (quote: string) => {
    const text = normalizeSpace(quote);
    return Boolean(text) && highlights.some((highlight) => highlight.includes(text) || text.includes(highlight));
  };
  return outputs
    .flatMap((output) => output.points)
    .map((point, index) => ({
      id: `p${index + 1}`,
      statement: point.statement,
      quote: point.quote,
      section: point.section,
      concept: point.concept,
      importance: marked(point.quote) ? "core" : point.importance,
      turn_item_id: point.turn_item_id && questions.has(point.turn_item_id) ? point.turn_item_id : null,
      question: point.turn_item_id ? (questions.get(point.turn_item_id) ?? null) : null
    }));
}

/** ④ related entries ∪ per-concept name match / vector recall, best first. */
async function candidateEntries(
  ctx: ProcessingContext,
  points: KnowledgePoint[],
  related: ScoredRelatedEntry[],
  entriesById: Map<string, EntryRecord>
): Promise<EntryRecord[]> {
  const scores = new Map<string, number>();
  const bump = (id: string, similarity: number) => {
    if (entriesById.has(id) && similarity > (scores.get(id) ?? -1)) scores.set(id, similarity);
  };
  for (const scored of related.slice(0, MAX_RELATED)) bump(scored.entry_id, scored.similarity);
  const entries = [...entriesById.values()];
  for (const concept of new Set(points.map((point) => point.concept))) {
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

// ponytail: candidate bodies are cut at CANDIDATE_BODY_BUDGET (later ones get summary + outline only); split compose per entry group if bodies are routinely long.
function composeInput(
  ctx: ProcessingContext,
  unit: WorkUnit,
  points: KnowledgePoint[],
  candidates: EntryRecord[],
  triage: { thesis: string; user_focus: string[] }
): KnowledgeComposeInput {
  const anchor = unit.items[0]!;
  let bodyTokens = 0;
  return {
    step: "compose",
    mode: unit.adopt ? "adopt" : "normal",
    learner_profile: ctx.profile,
    item: {
      item_id: anchor.id,
      type: anchor.type,
      source_kind: sourceKindOf(anchor.type, anchor.url),
      title: anchor.title,
      thesis: triage.thesis,
      user_focus: triage.user_focus,
      requirement: ctx.requirement
    },
    points: points.map(({ id, statement, concept, importance, section }) => ({ id, statement, concept, importance, section })),
    candidate_entries: candidates.map((entry) => {
      bodyTokens += estimateTokens(entry.body);
      return {
        entry_id: entry.id,
        name: entry.name,
        aliases: entry.aliases,
        kind: normalizeKind(entry.kind),
        summary: entry.summary ?? "",
        outline: outlineOf(entry.body),
        ...(bodyTokens <= CANDIDATE_BODY_BUDGET ? { body_markdown: entry.body } : {})
      };
    }),
    neighbor_entries: neighborEntries(
      ctx.db,
      candidates.map((entry) => entry.id)
    ),
    ignored_names: ctx.ignoredNames.slice(0, MAX_IGNORED_NAMES),
    categories: categoryNames(ctx.db),
    kinds: kindVocabulary(ctx.db),
    feedback: null
  };
}

type Composed = { output: KnowledgeComposeOutput; model: string; retries: number; missing: string[] };

/** S3+S4 with S5: one retry on structural problems (then fail), one retry on missing points (keep the better result). */
async function composeWithCoverage(ctx: ProcessingContext, input: KnowledgeComposeInput, points: KnowledgePoint[]): Promise<Composed> {
  const prompt = PROMPTS.knowledge_compose as Prompt<KnowledgeComposeInput, KnowledgeComposeOutput>;
  const known = new Set([...input.candidate_entries.map((entry) => entry.entry_id), ...input.neighbor_entries.map((entry) => entry.entry_id)]);
  let { object: output, model } = await run(ctx.llm, prompt, input);
  let retries = 0;
  const problems = validateCompose(output, points, known);
  if (problems.length) {
    retries += 1;
    ({ object: output, model } = await run(ctx.llm, prompt, { ...input, feedback: problems }));
    const remaining = validateCompose(output, points, known);
    if (remaining.length) throw new Error(`compose invalid: ${remaining.join("; ")}`);
  }
  let missing = missingPoints(output, points);
  if (missing.length) {
    retries += 1;
    const retry = await run(ctx.llm, prompt, { ...input, feedback: [missingFeedback(missing)] });
    const retryMissing = missingPoints(retry.object, points);
    if (validateCompose(retry.object, points, known).length === 0 && retryMissing.length < missing.length) {
      output = retry.object;
      model = retry.model;
      missing = retryMissing;
    }
  }
  return { output, model, retries, missing: missing.map((point) => point.id) };
}

export type ProcessOutcome = {
  output: KnowledgeProcessingOutput;
  /** Per-step model outputs, kept in `organize_results.output` for calibration. */
  raw: unknown;
  route: "llm";
  fallback: ValueScoreFallbackResult | null;
  model: string | null;
};

function excerptEvidence(item: OrganizeItem): Array<{ quote: string; question: string | null; turn_item_id: string | null }> {
  const quote =
    item.highlights[0] ??
    item.body
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("#"))
      ?.trim() ??
    item.title;
  return [{ quote: quote.slice(0, 500), question: null, turn_item_id: null }];
}

export async function processUnit(
  ctx: ProcessingContext,
  unit: WorkUnit,
  related: ScoredRelatedEntry[],
  entriesById: Map<string, EntryRecord>
): Promise<ProcessOutcome> {
  const anchor = unit.items[0]!;
  const triage = await run(ctx.llm, PROMPTS.knowledge_triage as Prompt<KnowledgeTriageInput, KnowledgeTriageOutput>, buildTriageInput(ctx, unit, related, entriesById));
  const verdict = triage.object;
  const raw: Record<string, unknown> = { triage: verdict };
  const base = { item_id: anchor.id, value_score: verdict.value_score, reason: verdict.reason };
  const outcome = (output: KnowledgeProcessingOutput, model: string, fallback: ValueScoreFallbackResult | null = null): ProcessOutcome => ({
    output,
    raw,
    route: "llm",
    fallback,
    model
  });

  let decision = verdict.decision;
  if (unit.adopt && decision === "reject") decision = "proceed";
  const targets = verdict.target_entry_ids.filter((id) => entriesById.has(id));
  if (decision === "duplicate" && (hasUserMarks(unit) || targets.length === 0)) decision = "proceed";

  if (decision === "reject") return outcome({ ...base, decision: "reject", reject_reason: verdict.reject_reason ?? "low_information" }, triage.model);
  if (decision === "duplicate") {
    const evidence = verdict.duplicate_quotes.length
      ? verdict.duplicate_quotes.map((quote) => ({ quote, question: null, turn_item_id: null }))
      : excerptEvidence(anchor);
    return outcome({ ...base, decision: "duplicate", target_entry_ids: targets, evidence_by_entry: targets.map((entry_id) => ({ entry_id, evidence })) }, triage.model);
  }

  let fallback: ValueScoreFallbackResult | null = null;
  if (!unit.adopt) {
    fallback = applyValueScoreFallback({ decision: "new", value_score: verdict.value_score, engagement: unit.engagement, uncertain: unit.episode?.uncertain ?? false });
    if (fallback.overridden) return outcome({ ...base, decision: "reject", reject_reason: "low_information" }, triage.model, fallback);
  }

  const focus = { thesis: verdict.thesis?.trim() || anchor.title, user_focus: verdict.user_focus };
  const chunks = chunkUnit(unit);
  const extractPrompt = PROMPTS.knowledge_extract as Prompt<KnowledgeExtractInput, KnowledgeExtractOutput>;
  const extracted = await mapLimit(chunks, EXTRACT_CONCURRENCY, (chunk) =>
    retryOnce(ctx.llm, () => run(ctx.llm, extractPrompt, extractInput(unit, chunk, focus.thesis, focus.user_focus)))
  );
  const points = collectPoints(
    unit,
    extracted.map((result) => result.object)
  );
  raw.chunks = chunks.length;
  raw.points = points;
  if (points.length === 0) {
    if (unit.adopt) throw new Error("extract produced no knowledge points");
    return outcome({ ...base, decision: "reject", reject_reason: "low_information" }, extracted[0]?.model ?? triage.model, fallback);
  }

  const candidates = await candidateEntries(ctx, points, related, entriesById);
  const composed = await composeWithCoverage(ctx, composeInput(ctx, unit, points, candidates, focus), points);
  raw.compose = composed.output;
  raw.compose_retries = composed.retries;
  raw.missing_after_retry = composed.missing;
  const output = assembleResult(composed.output, points, base);
  if (unit.adopt && output.decision === "reject") throw new Error("compose assigned no knowledge points in adopt mode");
  return outcome(output, composed.model, fallback);
}
