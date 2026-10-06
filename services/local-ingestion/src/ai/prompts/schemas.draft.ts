/**
 * Draft input/output schemas for ③ learning judge, ⑤ knowledge processing (17: extract → align) and entry restructure.
 * Replace with imports from `src/domains/organize/schemas.ts` once that module lands.
 *
 * Deviations from the 07 examples, chosen so every provider's structured output (Gemini, Ollama, OpenAI-style strict)
 * accepts the JSON Schema:
 * - optional fields are `nullable` instead of omitted;
 * - maps become arrays: `item_engagement` → `[{ item_id, engagement }]`.
 */
import { z } from "zod";

// ③ Learning Judge

const timelineEvent = z.discriminatedUnion("kind", [
  z.object({ t: z.string(), kind: z.literal("search"), query: z.string(), engine: z.string().optional() }),
  z.object({
    t: z.string(),
    kind: z.literal("page"),
    title: z.string(),
    domain: z.string().optional(),
    category: z.enum(["learning_candidate", "neutral", "unrelated"]),
    active_sec: z.number(),
    scroll: z.number().optional(),
    captured_item_id: z.string().optional(),
    from: z.string().optional(),
    revisit: z.boolean().optional()
  }),
  z.object({
    t: z.string(),
    kind: z.literal("ai_turn"),
    platform: z.string().optional(),
    conversation_id: z.string(),
    question: z.string(),
    turn_index: z.number(),
    captured_item_id: z.string().optional()
  }),
  z.object({ t: z.string(), kind: z.literal("selection"), text: z.string(), captured_item_id: z.string().optional() }),
  z.object({ t: z.string(), kind: z.literal("copy"), text: z.string(), captured_item_id: z.string().optional() }),
  z.object({ t: z.string(), kind: z.literal("note"), text: z.string(), captured_item_id: z.string().optional() }),
  z.object({ t: z.string(), kind: z.literal("distraction"), domain_category: z.string(), duration_sec: z.number() })
]);

export const learningJudgeInputSchema = z.object({
  episode_id: z.string(),
  time_range: z.object({ start: z.string(), end: z.string() }),
  active_minutes: z.number(),
  learner_profile: z.object({
    role: z.string(),
    learning_focus: z.array(z.object({ topic: z.string(), expires_at: z.string() }))
  }),
  recent_kb_topics: z.array(z.string()),
  timeline: z.array(timelineEvent),
  flags: z.array(z.enum(["long_distraction"]))
});
export type LearningJudgeInput = z.infer<typeof learningJudgeInputSchema>;

export const ENGAGEMENT_LEVELS = ["strong", "medium", "weak"] as const;

export const LEARNING_SIGNALS = [
  "active_search",
  "ai_multi_turn",
  "follow_up",
  "note",
  "highlight",
  "copy",
  "return",
  "revisit",
  "cross_source",
  "practice",
  "long_dwell",
  "deep_scroll"
] as const;

export const learningJudgeOutputSchema = z.object({
  episode_id: z.string(),
  is_learning: z.boolean(),
  confidence: z.number().min(0).max(1),
  topic: z.string().nullable(),
  learning_goal: z.string().nullable(),
  related_exploration: z.array(z.string()),
  distractions: z.array(z.object({ start: z.string(), duration_sec: z.number(), type: z.enum(["unrelated_browsing", "topic_switch", "other"]) })),
  returned_to_topic: z.boolean().nullable().describe("没有分心时为 null"),
  signals_observed: z.array(z.enum(LEARNING_SIGNALS)),
  segment_suggestion: z.object({
    action: z.enum(["keep", "split", "merge"]),
    at: z.string().nullable().describe("split 时的切分时间点 HH:mm"),
    with_episode_id: z.string().nullable().describe("merge 时的目标片段")
  }),
  worth_extracting: z.boolean(),
  candidate_item_ids: z.array(z.string()),
  item_engagement: z.array(z.object({ item_id: z.string(), engagement: z.enum(ENGAGEMENT_LEVELS) })),
  reason: z.string()
});
export type LearningJudgeOutput = z.infer<typeof learningJudgeOutputSchema>;

// ⑤ Knowledge Processing

export const SOURCE_KINDS = ["official_doc", "repo", "community", "blog", "ai_answer", "other"] as const;

const conversationTurn = z.object({ turn_item_id: z.string(), turn_index: z.number(), question: z.string(), answer: z.string() });

export const RELATION_TYPES = ["part_of", "prerequisite", "related", "contrasts"] as const;

const relation = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(RELATION_TYPES),
  description: z.string().nullable().describe("contrasts 必填：一句话区别")
});

// ⑤ Verbatim knowledge processing (17): extract (whole text, one call) → align

export const INSTRUCTION_KINDS = ["item_note", "fuzzy_note", "requirement"] as const;

export const knowledgeExtractInputSchema = z.object({
  step: z.literal("extract"),
  item: z.object({
    item_id: z.string(),
    type: z.enum(["webpage", "conversation", "document"]),
    source_kind: z.enum(SOURCE_KINDS),
    title: z.string(),
    url: z.string().nullable()
  }),
  text: z.string().nullable().describe("网页 / 文档全文；问答时为 null"),
  turns: z.array(conversationTurn).nullable().describe("问答线程：每轮问题 + 完整回答"),
  user_highlights: z.array(z.string()),
  instructions: z
    .array(z.object({ kind: z.enum(INSTRUCTION_KINDS), text: z.string() }))
    .describe("item_note = 条目备注，fuzzy_note = 模糊备注，requirement = 整理要求"),
  ignored_names: z.array(z.string()),
  feedback: z.array(z.string()).nullable()
});
export type KnowledgeExtractInput = z.infer<typeof knowledgeExtractInputSchema>;

export const REMOVED_REASONS = ["instruction", "boilerplate"] as const;

export const knowledgeExtractOutputSchema = z.object({
  fragments: z.array(
    z.object({
      concept: z.string().describe("片段所属知识概念名（词条级名词）"),
      heading: z.string().describe("片段章节标题（不带 #）"),
      markdown: z.string().describe("清洗后的原文片段：保留原文措辞、代码块、表格、图示"),
      summarized: z.boolean().describe("按指令只留摘要时为 true，否则 false"),
      source_section: z.string().nullable().describe("片段在原文中所在章节的标题原文，无标题为 null"),
      turn_item_id: z.string().nullable().describe("问答来源填该轮 turn_item_id，否则 null")
    })
  ),
  removed: z.array(z.object({ source_section: z.string().nullable(), reason: z.enum(REMOVED_REASONS) }))
});
export type KnowledgeExtractOutput = z.infer<typeof knowledgeExtractOutputSchema>;

const entryRef = z.object({ entry_id: z.string(), name: z.string(), aliases: z.array(z.string()) });

export const knowledgeAlignInputSchema = z.object({
  step: z.literal("align"),
  item: z.object({ item_id: z.string(), type: z.enum(["webpage", "conversation", "document"]), source_kind: z.enum(SOURCE_KINDS), title: z.string() }),
  fragments: z.array(z.object({ fragment_id: z.string(), concept: z.string(), heading: z.string(), excerpt: z.string().describe("片段正文前 300 字") })),
  candidate_entries: z.array(
    entryRef.extend({
      kind: z.string(),
      summary: z.string(),
      sections: z.array(z.object({ section_id: z.string(), heading: z.string().nullable(), excerpt: z.string().describe("章节正文前 200 字") }))
    })
  ),
  neighbor_entries: z.array(entryRef),
  categories: z.array(z.string()),
  kinds: z.array(z.string()),
  ignored_names: z.array(z.string()),
  feedback: z.array(z.string()).nullable()
});
export type KnowledgeAlignInput = z.infer<typeof knowledgeAlignInputSchema>;

export const knowledgeAlignOutputSchema = z.object({
  assignments: z.array(
    z.object({
      fragment_id: z.string(),
      entry: z.string().describe("已有词条 entry_id（candidate_entries / neighbor_entries），或 new_entries 中的 key"),
      covered_by: z.string().nullable().describe("该词条已有章节已完整覆盖此片段时填其 section_id，否则 null")
    })
  ),
  new_entries: z.array(
    z.object({
      key: z.string().describe('形如 "new:名称"'),
      name: z.string(),
      aliases: z.array(z.string()),
      kind: z.string().describe("必须取自 kinds；都不合适时用「其他」"),
      category: z.string(),
      summary: z.string()
    })
  ),
  relations: z.array(relation),
  item_summary: z.string(),
  item_points: z.array(z.string())
});
export type KnowledgeAlignOutput = z.infer<typeof knowledgeAlignOutputSchema>;

// Entry Restructure (17: replaces entry rewrite; `headings` is an array instead of a map)

export const entryRestructureInputSchema = z.object({
  entry: z.object({
    entry_id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    kind: z.string(),
    category: z.string(),
    summary: z.string(),
    patch_count: z.number()
  }),
  trigger: z.enum(["manual", "stale", "full"]),
  sections: z
    .array(
      z.object({
        section_id: z.string(),
        heading: z.string(),
        markdown: z.string().describe("章节正文（过长时截断）"),
        sources: z.array(z.object({ item_id: z.string(), title: z.string() })),
        mergeable: z.boolean().describe("false：手写 / 旧章节（u_ 开头），只能调序改名，不能合并或删除")
      })
    )
    .describe("按当前正文顺序"),
  requirement: z.string().nullable(),
  feedback: z.array(z.string()).nullable()
});
export type EntryRestructureInput = z.infer<typeof entryRestructureInputSchema>;

export const entryRestructureOutputSchema = z.object({
  order: z.array(z.string()).describe("调整后的 section_id 顺序；被合并删除的章节不出现"),
  headings: z.array(z.object({ section_id: z.string(), heading: z.string() })).describe("需要改名的章节，不改名的不列"),
  merge: z.array(z.object({ keep: z.string(), drop: z.array(z.string()) })).describe("重复章节：保留 keep，删除 drop，来源并入 keep"),
  summary: z.string()
});
export type EntryRestructureOutput = z.infer<typeof entryRestructureOutputSchema>;
