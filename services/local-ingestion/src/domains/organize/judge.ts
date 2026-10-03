import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PROMPTS } from "../../ai/prompts/index.js";
import type { LearningJudgeInput as PromptJudgeInput, LearningJudgeOutput } from "../../ai/prompts/schemas.draft.js";
import type { EpisodeRow } from "../../db/types.js";
import { stableStringify } from "./hash.js";
import { callLlm, type LlmContext } from "./llm.js";
import type { JudgeProfile } from "./context.js";
import type { ActivityEpisode, JudgeTimelineEntry, LearningJudgeInput } from "./types.js";

/** ③ Learning Judge: prompt input conversion, deterministic episode ids, per-episode result cache. */

export const JUDGE_PROMPT_VERSION = PROMPTS.learning_judge.version;

function promptTimelineEntry(entry: JudgeTimelineEntry): PromptJudgeInput["timeline"][number] {
  switch (entry.kind) {
    case "search":
      return { t: entry.t, kind: "search", query: entry.query, engine: entry.engine || undefined };
    case "page":
      return {
        t: entry.t,
        kind: "page",
        title: entry.title || entry.domain,
        domain: entry.domain || undefined,
        category: entry.category,
        active_sec: Math.round(entry.active_sec),
        scroll: entry.scroll,
        captured_item_id: entry.captured_item_id,
        from: entry.from,
        revisit: entry.revisit
      };
    case "ai_turn":
      return {
        t: entry.t,
        kind: "ai_turn",
        platform: entry.platform,
        conversation_id: entry.conversation_id ?? "",
        question: entry.question ?? "",
        turn_index: entry.turn_index ?? 1,
        captured_item_id: entry.captured_item_id
      };
    case "selection":
    case "copy":
      return { t: entry.t, kind: entry.kind, text: entry.text };
    case "note":
      return { t: entry.t, kind: "note", text: entry.text };
    case "distraction":
      return { t: entry.t, kind: "distraction", domain_category: entry.domain_category ?? "unrelated", duration_sec: Math.round(entry.duration_sec) };
  }
}

export function toPromptJudgeInput(input: LearningJudgeInput, profile: JudgeProfile, recentTopics: string[]): PromptJudgeInput {
  return {
    episode_id: input.episode_id,
    time_range: input.time_range,
    active_minutes: input.active_minutes,
    learner_profile: profile,
    recent_kb_topics: recentTopics,
    timeline: input.timeline.map(promptTimelineEntry),
    flags: [...new Set(input.flags)]
  };
}

/** Stable id from the behaviour summary, so an unchanged episode reuses its stored judgement. */
export function deterministicEpisodeId(input: LearningJudgeInput): string {
  const digest = createHash("sha256")
    .update(stableStringify({ time_range: input.time_range, timeline: input.timeline, flags: input.flags }))
    .digest("hex")
    .slice(0, 16);
  return `ep_${digest}`;
}

export function withEpisodeId(episode: ActivityEpisode, id: string): ActivityEpisode {
  return { ...episode, episodeId: id, judgeInput: { ...episode.judgeInput, episode_id: id } };
}

export function cachedJudgement(db: DatabaseSync, episodeId: string): LearningJudgeOutput | null {
  const row = db.prepare("SELECT judge_output, prompt_version FROM episodes WHERE id = ?").get(episodeId) as
    Pick<EpisodeRow, "judge_output" | "prompt_version"> | undefined;
  if (!row?.judge_output || row.prompt_version !== JUDGE_PROMPT_VERSION) return null;
  const parsed = PROMPTS.learning_judge.outputSchema(undefined as never).safeParse(JSON.parse(row.judge_output));
  return parsed.success ? parsed.data : null;
}

export async function judgeEpisode(ctx: LlmContext, input: PromptJudgeInput): Promise<LearningJudgeOutput> {
  const prompt = PROMPTS.learning_judge;
  const { object } = await callLlm(ctx, {
    stage: "learning_judge",
    task: "learning_judge",
    schema: prompt.outputSchema(input),
    system: prompt.system,
    prompt: prompt.buildUserPrompt(input),
    promptVersion: prompt.version,
    input
  });
  return object;
}

export type EpisodeStatusValue = "learning" | "not_learning" | "deferred";

export function saveEpisode(
  db: DatabaseSync,
  episode: ActivityEpisode,
  status: EpisodeStatusValue,
  judgement: LearningJudgeOutput | null,
  runId: string,
  anchorIds: string[],
  now: string
): void {
  db.prepare(
    `INSERT INTO episodes(id, started_at, ended_at, active_seconds, status, is_learning, confidence, topic, learning_goal, judge_output, run_id, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, is_learning = excluded.is_learning, confidence = excluded.confidence,
       topic = excluded.topic, learning_goal = excluded.learning_goal, judge_output = COALESCE(excluded.judge_output, episodes.judge_output),
       run_id = excluded.run_id, prompt_version = COALESCE(excluded.prompt_version, episodes.prompt_version)`
  ).run(
    episode.episodeId,
    episode.startedAt,
    episode.endedAt,
    Math.round(episode.activeSeconds),
    status,
    judgement ? (judgement.is_learning ? 1 : 0) : null,
    judgement?.confidence ?? null,
    judgement?.topic ?? null,
    judgement?.learning_goal ?? null,
    judgement ? JSON.stringify(judgement) : null,
    runId,
    judgement ? JUDGE_PROMPT_VERSION : null,
    now
  );
  const link = db.prepare("INSERT OR IGNORE INTO episode_items(episode_id, item_id) VALUES (?, ?)");
  for (const id of anchorIds) link.run(episode.episodeId, id);
}
