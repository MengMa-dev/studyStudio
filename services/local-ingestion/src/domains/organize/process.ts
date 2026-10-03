import type { DatabaseSync } from "node:sqlite";
import { sourceKindOf } from "@study-studio/shared";
import { z } from "zod";
import { PROMPTS } from "../../ai/prompts/index.js";
import { REJECT_REASONS, type KnowledgeProcessingInput, type KnowledgeProcessingOutput } from "../../ai/prompts/schemas.draft.js";
import type { ItemExposureRow } from "../../db/types.js";
import { estimateTokens } from "../../search/chunk.js";
import type { EngagementLevel } from "./constants.js";
import { callLlm, type LlmContext } from "./llm.js";
import { normalizeHeading } from "./normalize.js";
import { applyValueScoreFallback } from "./postprocess.js";
import { categoryNames, outlineOf, type EntryRecord, type OrganizeItem } from "./store.js";
import type { ScoredRelatedEntry, ValueScoreFallbackResult } from "./types.js";

/** ⑤ Knowledge Processing: input assembly, single call, long-text two-step path, τ fallback. */

export const PROCESSING_PROMPT_VERSION = PROMPTS.knowledge_processing.version;
export const LONG_JUDGE_PROMPT_VERSION = `${PROCESSING_PROMPT_VERSION}+long_judge@1`;

/** Body budget per call (07: content ≤ 10k tokens); above this the long path is used. */
export const CONTENT_TOKEN_BUDGET = 10_000;
const EXCERPT_TOKEN_BUDGET = 3_000;
const MAX_RELATED = 5;
const RELATED_WITH_BODY = 2;
const MAX_NEIGHBORS = 10;
const MAX_IGNORED_NAMES = 100;

export type WorkEpisode = {
  episodeId: string;
  topic: string | null;
  learningGoal: string | null;
  relatedExploration: string[];
  uncertain: boolean;
};

/** One ⑤ call: a single item, or a conversation thread (turns ordered, the first is the anchor). */
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

function exposureLabel(row: ItemExposureRow | undefined): string | null {
  if (!row) return null;
  const coverage = row.coverage ?? 0;
  const seconds = row.exposed_seconds ?? 0;
  if (coverage >= 0.5) return "高";
  if (coverage > 0 || seconds > 0) return "低";
  return "无";
}

/** Annotate headings with `[露出:高|低|无]` from `item_exposure` (no-op without exposure data). */
export function annotateExposure(markdown: string, exposure: ItemExposureRow[]): string {
  if (exposure.length === 0) return markdown;
  const byHeading = new Map(exposure.filter((row) => row.heading).map((row) => [normalizeHeading(row.heading!), row]));
  return markdown
    .split("\n")
    .map((line) => {
      if (!/^#{1,6}\s+\S/.test(line)) return line;
      const label = exposureLabel(byHeading.get(normalizeHeading(line)));
      return label ? `${line.trimEnd()} [露出:${label}]` : line;
    })
    .join("\n");
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

function exposedSeconds(section: Section, exposure: ItemExposureRow[]): number {
  if (!section.heading) return 0;
  const key = normalizeHeading(section.heading);
  return exposure.find((row) => row.heading && normalizeHeading(row.heading) === key)?.exposed_seconds ?? 0;
}

/** Long-path excerpt: sections around highlights → most exposed sections → document head (~3k tokens). */
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
    .sort((a, b) => exposedSeconds(b, item.exposure) - exposedSeconds(a, item.exposure))
    .forEach((section) => {
      if (exposedSeconds(section, item.exposure) > 0) add(section);
    });
  sections.forEach(add);
  return takeTokens(
    picked.map((section) => annotateExposure(sectionText(section), item.exposure)),
    budget
  );
}

/** Long-path focus content: `focus_sections` + exposed sections, within the body budget. */
export function buildFocusContent(item: OrganizeItem, focusSections: string[], budget = CONTENT_TOKEN_BUDGET): string {
  const sections = splitSections(item.body);
  const focus = new Set(focusSections.map(normalizeHeading));
  const chosen = sections.filter((section) => (section.heading && focus.has(normalizeHeading(section.heading))) || exposedSeconds(section, item.exposure) > 0);
  const ordered = chosen.length ? chosen : sections;
  return takeTokens(
    ordered.map((section) => annotateExposure(sectionText(section), item.exposure)),
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

export function buildProcessingInput(
  ctx: ProcessingContext,
  unit: WorkUnit,
  related: ScoredRelatedEntry[],
  entriesById: Map<string, EntryRecord>,
  content?: string
): KnowledgeProcessingInput {
  const anchor = unit.items[0]!;
  const top = related.slice(0, MAX_RELATED).filter((entry) => entriesById.has(entry.entry_id));
  const conversation = anchor.type === "conversation";
  return {
    mode: unit.adopt ? "adopt" : "normal",
    episode: unit.episode
      ? {
          episode_id: unit.episode.episodeId,
          topic: unit.episode.topic ?? "",
          learning_goal: unit.episode.learningGoal ?? "",
          uncertain: unit.episode.uncertain
        }
      : null,
    learner_profile: ctx.profile,
    item: {
      item_id: anchor.id,
      type: anchor.type,
      source_kind: sourceKindOf(anchor.type, anchor.url),
      title: anchor.title,
      ...(anchor.url ? { url: anchor.url } : {}),
      ...(conversation
        ? {
            turns: unit.items.map((item, index) => ({
              turn_item_id: item.id,
              turn_index: index + 1,
              question: item.question ?? item.title,
              answer: item.body
            }))
          }
        : { content: content ?? annotateExposure(anchor.body, anchor.exposure) }),
      user_highlights: unit.items.flatMap((item) => item.highlights),
      user_note: unit.items.flatMap((item) => item.itemNotes.map((note) => note.text)).join("\n") || null,
      fuzzy_notes: ctx.fuzzyNotes,
      requirement: ctx.requirement,
      engagement: unit.engagement
    },
    related_entries: top.map((scored, index) => {
      const entry = entriesById.get(scored.entry_id)!;
      return {
        entry_id: entry.id,
        name: entry.name,
        aliases: entry.aliases,
        kind: entry.kind ?? "concept",
        summary: entry.summary ?? "",
        similarity: round(scored.similarity),
        recency_relevance: round(scored.recency_relevance),
        outline: outlineOf(entry.body),
        ...(index < RELATED_WITH_BODY ? { body_markdown: entry.body } : {})
      };
    }),
    neighbor_entries: neighborEntries(
      ctx.db,
      top.map((entry) => entry.entry_id)
    ),
    ignored_names: ctx.ignoredNames.slice(0, MAX_IGNORED_NAMES),
    categories: categoryNames(ctx.db)
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function contentTokens(input: KnowledgeProcessingInput): number {
  const turns = input.item.turns?.map((turn) => `${turn.question}\n${turn.answer}`).join("\n") ?? "";
  return estimateTokens(`${input.item.content ?? ""}${turns}`);
}

export const longJudgeOutputSchema = z.object({
  item_id: z.string(),
  decision: z.enum(["new", "supplement", "duplicate", "reject"]),
  value_score: z.number().min(0).max(1),
  reason: z.string(),
  reject_reason: z.enum(REJECT_REASONS).nullable(),
  target_entry_ids: z.array(z.string()).describe("duplicate 时被覆盖的已有词条 entry_id，否则为空数组"),
  focus_sections: z.array(z.string()).describe("new / supplement 时值得抽取的章节标题原文")
});
export type LongJudgeOutput = z.infer<typeof longJudgeOutputSchema>;

const LONG_JUDGE_SYSTEM = `${PROMPTS.knowledge_processing.system}

## 仅判定模式（长文第一步）
本次只给出正文节选。只输出 decision、value_score、reason、reject_reason（非 reject 时为 null）、target_entry_ids（duplicate 时填写）与 focus_sections（new / supplement 时列出值得抽取的章节标题原文）；不要抽取概念、不要写补丁。`;

export type ProcessOutcome = {
  output: KnowledgeProcessingOutput;
  /** Raw model output(s) before the τ fallback, kept in `organize_results.output` for calibration. */
  raw: unknown;
  route: "llm" | "llm_long";
  fallback: ValueScoreFallbackResult | null;
  model: string | null;
};

async function processOnce(ctx: ProcessingContext, input: KnowledgeProcessingInput): Promise<{ output: KnowledgeProcessingOutput; model: string }> {
  const prompt = PROMPTS.knowledge_processing;
  const { object, model } = await callLlm(ctx.llm, {
    stage: "knowledge_processing",
    task: "knowledge_processing",
    schema: prompt.outputSchema(input) as z.ZodType<KnowledgeProcessingOutput>,
    system: prompt.system,
    prompt: prompt.buildUserPrompt(input),
    promptVersion: prompt.version,
    input
  });
  return { output: object, model };
}

function excerptEvidence(item: OrganizeItem, excerpt: string): Array<{ quote: string; question: string | null; turn_item_id: string | null }> {
  const quote =
    item.highlights[0] ??
    excerpt
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
  const input = buildProcessingInput(ctx, unit, related, entriesById);
  const anchor = unit.items[0]!;
  let route: ProcessOutcome["route"] = "llm";
  let output: KnowledgeProcessingOutput;
  let model: string | null;
  let raw: unknown;

  if (anchor.type !== "conversation" && contentTokens(input) > CONTENT_TOKEN_BUDGET) {
    route = "llm_long";
    const excerpt = buildExcerpt(anchor);
    const judgeInput = { ...input, item: { ...input.item, content: excerpt } };
    const prompt = PROMPTS.knowledge_processing;
    const judged = await callLlm(ctx.llm, {
      stage: "knowledge_processing",
      task: "knowledge_processing",
      schema: longJudgeOutputSchema,
      system: LONG_JUDGE_SYSTEM,
      prompt: prompt.buildUserPrompt(judgeInput),
      promptVersion: LONG_JUDGE_PROMPT_VERSION,
      input: { ...judgeInput, judge_only: true }
    });
    const verdict = judged.object;
    model = judged.model;
    const decision = unit.adopt && verdict.decision === "reject" ? "new" : verdict.decision;
    if (decision === "reject") {
      output = {
        item_id: anchor.id,
        decision,
        value_score: verdict.value_score,
        reason: verdict.reason,
        reject_reason: verdict.reject_reason ?? "low_information"
      };
      raw = { judge: verdict };
    } else if (decision === "duplicate") {
      const targets = verdict.target_entry_ids.filter((id) => entriesById.has(id));
      if (targets.length === 0) throw new Error("long-path duplicate without a known target entry");
      output = {
        item_id: anchor.id,
        decision,
        value_score: verdict.value_score,
        reason: verdict.reason,
        target_entry_ids: targets,
        evidence_by_entry: targets.map((entry_id) => ({ entry_id, evidence: excerptEvidence(anchor, excerpt) }))
      };
      raw = { judge: verdict };
    } else {
      const focused = buildProcessingInput(ctx, unit, related, entriesById, buildFocusContent(anchor, verdict.focus_sections));
      const extracted = await processOnce(ctx, focused);
      output = extracted.output;
      model = extracted.model;
      raw = { judge: verdict, extract: extracted.output };
    }
  } else {
    const result = await processOnce(ctx, input);
    output = result.output;
    model = result.model;
    raw = result.output;
  }

  if (unit.adopt) return { output, raw, route, fallback: null, model };
  const fallback = applyValueScoreFallback({
    decision: output.decision,
    value_score: output.value_score,
    engagement: unit.engagement,
    uncertain: unit.episode?.uncertain ?? false
  });
  if (fallback.overridden) {
    output = { item_id: output.item_id, decision: "reject", value_score: output.value_score, reason: output.reason, reject_reason: "low_information" };
  }
  return { output, raw, route, fallback, model };
}
