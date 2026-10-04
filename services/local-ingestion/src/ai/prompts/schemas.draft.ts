/**
 * Draft input/output schemas for ③ learning judge, ⑤ knowledge processing and entry rewrite (07-organize).
 * Replace with imports from `src/domains/organize/schemas.ts` once that module lands.
 *
 * Deviations from the 07 examples, chosen so every provider's structured output (Gemini, Ollama, OpenAI-style strict)
 * accepts the JSON Schema:
 * - optional fields are `nullable` instead of omitted;
 * - maps become arrays: `item_engagement` → `[{ item_id, engagement }]`, `evidence_by_entry` → `[{ entry_id, evidence }]`;
 * - a concept is one flat object: existing-entry fields (`patch`) and new-entry fields (`summary`, `body_markdown`, …) are null when not applicable.
 */
import { z } from "zod";

const learnerProfile = z.object({
  role: z.string(),
  learning_focus: z.array(z.string()).describe("未过期的近期学习方向")
});

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

export const knowledgeProcessingInputSchema = z.object({
  mode: z.enum(["normal", "adopt"]).describe("adopt = 手动整理未采纳条目，decision 只能是 new / supplement / duplicate"),
  episode: z
    .object({ episode_id: z.string(), topic: z.string(), learning_goal: z.string(), uncertain: z.boolean() })
    .nullable()
    .describe("手动整理跳过 ③ 时为 null"),
  learner_profile: learnerProfile,
  item: z.object({
    item_id: z.string(),
    type: z.enum(["webpage", "conversation", "document"]),
    source_kind: z.enum(SOURCE_KINDS),
    title: z.string(),
    url: z.string().optional(),
    content: z.string().optional().describe("网页 / 文档正文，章节标注露出权重"),
    turns: z.array(conversationTurn).optional().describe("问答会话线程，按轮次排序"),
    user_highlights: z.array(z.string()),
    user_note: z.string().nullable(),
    fuzzy_notes: z.array(z.string()),
    requirement: z.string().nullable(),
    engagement: z.enum(ENGAGEMENT_LEVELS)
  }),
  related_entries: z.array(
    z.object({
      entry_id: z.string(),
      name: z.string(),
      aliases: z.array(z.string()),
      kind: z.string(),
      summary: z.string(),
      similarity: z.number(),
      recency_relevance: z.number(),
      outline: z.array(z.string()),
      body_markdown: z.string().optional()
    })
  ),
  neighbor_entries: z.array(z.object({ entry_id: z.string(), name: z.string(), aliases: z.array(z.string()) })),
  ignored_names: z.array(z.string()),
  categories: z.array(z.string()),
  kinds: z.array(z.string())
});
export type KnowledgeProcessingInput = z.infer<typeof knowledgeProcessingInputSchema>;

export const REJECT_REASONS = ["off_topic", "low_information", "navigational", "transient", "ignored"] as const;
export const RELATION_TYPES = ["part_of", "prerequisite", "related", "contrasts"] as const;

export const POINT_IMPORTANCE = ["core", "supporting", "detail"] as const;
export type PointImportance = (typeof POINT_IMPORTANCE)[number];

const evidence = z.object({
  quote: z.string().describe("条目原文摘录"),
  question: z.string().nullable().describe("问答来源时为该轮的用户问题，否则 null"),
  turn_item_id: z.string().nullable().describe("问答来源时为该轮的 item_id，否则 null"),
  point: z.string().nullable().optional().describe("知识点陈述（多轮处理生成）"),
  importance: z.enum(POINT_IMPORTANCE).nullable().optional()
});

const completeness = z.object({ covered: z.array(z.string()), missing: z.array(z.string()) });

const patchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_to_section"), section: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("add_section"), after: z.string(), heading: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("replace_section"), section: z.string(), markdown: z.string() })
]);

const concept = z.object({
  name: z.string(),
  match: z.string().describe('已有词条 entry_id（来自 related_entries / neighbor_entries），或 "new"'),
  aliases: z.array(z.string()),
  kind: z.string().describe("优先取自 kinds；都不合适时给新类型名"),
  evidence: z.array(evidence).min(1),
  patch: z
    .object({
      ops: z.array(patchOp).min(1),
      summary: z.string().nullable().describe("摘要需要变化时才输出"),
      completeness: completeness.nullable()
    })
    .nullable()
    .describe('match 为已有词条时必填，match="new" 时为 null'),
  category: z.string().nullable().describe('match="new" 时必填'),
  summary: z.string().nullable().describe('match="new" 时必填'),
  body_markdown: z.string().nullable().describe('match="new" 时必填'),
  completeness: completeness.nullable().describe('match="new" 时必填')
});

const relation = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(RELATION_TYPES),
  description: z.string().nullable().describe("contrasts 必填：一句话区别")
});

const common = { item_id: z.string(), value_score: z.number().min(0).max(1), reason: z.string() };
const extraction = { item_summary: z.string(), item_points: z.array(z.string()), concepts: z.array(concept).min(1), relations: z.array(relation) };

const newDecision = z.object({ ...common, decision: z.literal("new"), ...extraction });
const supplementDecision = z.object({ ...common, decision: z.literal("supplement"), ...extraction });
const duplicateDecision = z.object({
  ...common,
  decision: z.literal("duplicate"),
  target_entry_ids: z.array(z.string()).min(1),
  evidence_by_entry: z.array(z.object({ entry_id: z.string(), evidence: z.array(evidence).min(1) }))
});
const rejectDecision = z.object({ ...common, decision: z.literal("reject"), reject_reason: z.enum(REJECT_REASONS) });

export const knowledgeProcessingOutputSchema = z.discriminatedUnion("decision", [newDecision, supplementDecision, duplicateDecision, rejectDecision]);
export type KnowledgeProcessingOutput = z.infer<typeof knowledgeProcessingOutputSchema>;

/** Adopt mode (manual organize of a rejected item): no value gate, `reject` is not allowed. */
export const knowledgeProcessingAdoptOutputSchema = z.discriminatedUnion("decision", [newDecision, supplementDecision, duplicateDecision]);

// ⑤ Multistep knowledge processing (15): S1 triage → S2 extract (per chunk) → S3+S4 compose

const relatedEntryBrief = z.object({
  entry_id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  kind: z.string(),
  summary: z.string(),
  similarity: z.number(),
  recency_relevance: z.number(),
  outline: z.array(z.string())
});

export const knowledgeTriageInputSchema = z.object({
  step: z.literal("triage"),
  mode: z.enum(["normal", "adopt"]),
  episode: z.object({ episode_id: z.string(), topic: z.string(), learning_goal: z.string(), uncertain: z.boolean() }).nullable(),
  learner_profile: learnerProfile,
  item: z.object({
    item_id: z.string(),
    type: z.enum(["webpage", "conversation", "document"]),
    source_kind: z.enum(SOURCE_KINDS),
    title: z.string(),
    url: z.string().optional(),
    outline: z.array(z.string()).describe("全文标题大纲"),
    excerpt: z.string().optional().describe("正文节选（短内容为全文）"),
    turns: z.array(conversationTurn).optional().describe("问答线程：全部问题 + 每轮回答开头"),
    user_highlights: z.array(z.string()),
    user_note: z.string().nullable(),
    fuzzy_notes: z.array(z.string()),
    requirement: z.string().nullable(),
    engagement: z.enum(ENGAGEMENT_LEVELS)
  }),
  related_entries: z.array(relatedEntryBrief),
  ignored_names: z.array(z.string())
});
export type KnowledgeTriageInput = z.infer<typeof knowledgeTriageInputSchema>;

const triageFields = {
  item_id: z.string(),
  value_score: z.number().min(0).max(1),
  reason: z.string(),
  reject_reason: z.enum(REJECT_REASONS).nullable(),
  target_entry_ids: z.array(z.string()).describe("duplicate 时覆盖它的已有词条，否则为空数组"),
  duplicate_quotes: z.array(z.string()).describe("duplicate 时摘自原文的 1–3 段证据，否则为空数组"),
  thesis: z.string().nullable().describe("proceed 时必填：整个条目的核心论点"),
  user_focus: z.array(z.string()).describe("用户关心的具体问题")
};
export const knowledgeTriageOutputSchema = z.object({ ...triageFields, decision: z.enum(["proceed", "duplicate", "reject"]) });
export const knowledgeTriageAdoptOutputSchema = z.object({ ...triageFields, decision: z.enum(["proceed", "duplicate"]) });
export type KnowledgeTriageOutput = z.infer<typeof knowledgeTriageOutputSchema>;

export const knowledgeExtractInputSchema = z.object({
  step: z.literal("extract"),
  item: z.object({ item_id: z.string(), type: z.enum(["webpage", "conversation", "document"]), source_kind: z.enum(SOURCE_KINDS), title: z.string() }),
  thesis: z.string(),
  user_focus: z.array(z.string()),
  user_highlights: z.array(z.string()),
  user_note: z.string().nullable(),
  chunk: z.object({
    index: z.number(),
    total: z.number(),
    heading_path: z.array(z.string()),
    text: z.string().nullable(),
    turns: z.array(conversationTurn).nullable(),
    context_question: z.string().nullable()
  })
});
export type KnowledgeExtractInput = z.infer<typeof knowledgeExtractInputSchema>;

export const knowledgeExtractOutputSchema = z.object({
  points: z.array(
    z.object({
      statement: z.string().describe("一句完整、脱离上下文可读的中文陈述"),
      quote: z.string().describe("逐字摘自分块原文"),
      section: z.string().nullable(),
      concept: z.string().describe("所属知识概念名（词条级别）"),
      importance: z.enum(POINT_IMPORTANCE),
      turn_item_id: z.string().nullable()
    })
  )
});
export type KnowledgeExtractOutput = z.infer<typeof knowledgeExtractOutputSchema>;

export const DROP_REASONS = ["covered", "trivial", "off_topic", "unreliable"] as const;

export const knowledgeComposeInputSchema = z.object({
  step: z.literal("compose"),
  mode: z.enum(["normal", "adopt"]),
  learner_profile: learnerProfile,
  item: z.object({
    item_id: z.string(),
    type: z.enum(["webpage", "conversation", "document"]),
    source_kind: z.enum(SOURCE_KINDS),
    title: z.string(),
    thesis: z.string(),
    user_focus: z.array(z.string()),
    requirement: z.string().nullable()
  }),
  points: z.array(z.object({ id: z.string(), statement: z.string(), concept: z.string(), importance: z.enum(POINT_IMPORTANCE), section: z.string().nullable() })),
  candidate_entries: z.array(
    z.object({
      entry_id: z.string(),
      name: z.string(),
      aliases: z.array(z.string()),
      kind: z.string(),
      summary: z.string(),
      outline: z.array(z.string()),
      body_markdown: z.string().optional()
    })
  ),
  neighbor_entries: z.array(z.object({ entry_id: z.string(), name: z.string(), aliases: z.array(z.string()) })),
  ignored_names: z.array(z.string()),
  categories: z.array(z.string()),
  kinds: z.array(z.string()),
  feedback: z.array(z.string()).nullable()
});
export type KnowledgeComposeInput = z.infer<typeof knowledgeComposeInputSchema>;

const composeConcept = z.object({
  name: z.string(),
  match: z.string().describe('已有词条 entry_id（来自 candidate_entries / neighbor_entries），或 "new"'),
  aliases: z.array(z.string()),
  kind: z.string(),
  point_ids: z.array(z.string()).min(1).describe("分配给该词条的知识点 id"),
  patch: z
    .object({ ops: z.array(patchOp).min(1), summary: z.string().nullable(), completeness: completeness.nullable() })
    .nullable()
    .describe("已有词条有新增内容时填写；分到的知识点都已被正文覆盖、或 match=\"new\" 时为 null"),
  category: z.string().nullable().describe('match="new" 时必填'),
  summary: z.string().nullable().describe('match="new" 时必填'),
  body_markdown: z.string().nullable().describe('match="new" 时必填'),
  completeness: completeness.nullable().describe('match="new" 时必填')
});

export const knowledgeComposeOutputSchema = z.object({
  item_summary: z.string(),
  item_points: z.array(z.string()),
  concepts: z.array(composeConcept),
  relations: z.array(relation),
  dropped: z.array(
    z.object({ point_id: z.string(), reason: z.enum(DROP_REASONS), entry_id: z.string().nullable().describe("covered 时为已覆盖它的词条") })
  )
});
export type KnowledgeComposeOutput = z.infer<typeof knowledgeComposeOutputSchema>;

// Entry Rewrite

export const entryRewriteInputSchema = z.object({
  entry: z.object({
    entry_id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    kind: z.string(),
    category: z.string(),
    summary: z.string(),
    body_markdown: z.string(),
    patch_count: z.number()
  }),
  trigger: z.enum(["manual", "stale", "full"]),
  evidence: z
    .array(
      z.object({
        id: z.string(),
        item_id: z.string(),
        source_kind: z.enum(SOURCE_KINDS),
        title: z.string(),
        point: z.string().nullable().describe("知识点陈述；为 null 时以 quote 为要点"),
        importance: z.enum(POINT_IMPORTANCE),
        quote: z.string(),
        question: z.string().nullable()
      })
    )
    .describe("按重要度、来源可靠性排序：core 在前；official_doc / repo 在前，ai_answer 在后"),
  entry_notes: z.array(z.string()),
  requirement: z.string().nullable(),
  related_entry_names: z.array(z.string()),
  feedback: z.array(z.string()).nullable()
});
export type EntryRewriteInput = z.infer<typeof entryRewriteInputSchema>;

export const entryRewriteOutputSchema = z.object({
  body_markdown: z.string(),
  summary: z.string(),
  completeness: completeness,
  covered_ids: z.array(z.string()).describe("正文已写入的 evidence id"),
  dropped: z.array(z.object({ id: z.string(), reason: z.enum(["redundant", "unreliable"]) }))
});
export type EntryRewriteOutput = z.infer<typeof entryRewriteOutputSchema>;
