import { tool } from "ai";
import { z } from "zod";
import { getActiveItem } from "../../inbox/detail.js";
import { loadAliveEntry } from "../../kb/queries.js";
import type { CreateChatTools } from "../contracts.js";
import { getItem } from "./item.js";
import { getEntry, listMastery, MASTERY_LIST_MAX_LIMIT, SEARCH_DEFAULT_K, SEARCH_MAX_K, searchKnowledge } from "./knowledge.js";
import { ORGANIZE_TARGETS, resolveOrganizeOptions, type OrganizeLookups } from "./organize-options.js";
import { recordLearnerProfile } from "./profile.js";
import { queryTimeline } from "./timeline.js";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const createChatTools: CreateChatTools = (deps, req) => {
  const { db } = deps;
  const { context, registry, emit } = req;
  const now = () => deps.now?.() ?? new Date();
  const lookups: OrganizeLookups = {
    entryName: (id) => loadAliveEntry(db, id)?.name ?? null,
    itemTitle: (id) => {
      const item = getActiveItem(db, id);
      return item ? (item.title ?? item.url ?? item.id) : null;
    }
  };

  return {
    query_timeline: tool({
      description:
        "查询用户在某段日期内的学习记录：每天的学习时长、阅读过的网页与 AI 问答（标题、站点、时长、itemId）。" +
        "用户问「今天/昨天/本周/最近几天学了什么」「学了多久」等回顾类问题时使用。日期为本地日期 YYYY-MM-DD，都省略时默认最近 7 天（含今天）。",
      inputSchema: z.object({
        from: day.describe("开始日期 YYYY-MM-DD（含），可省略"),
        to: day.describe("结束日期 YYYY-MM-DD（含），可省略，默认今天")
      }),
      execute: (input) => queryTimeline(db, registry, input, now())
    }),

    search_knowledge: tool({
      description:
        "在用户的知识库词条与收集内容中检索与问题相关的知识，返回词条（名称、摘要、掌握度、命中片段）和条目片段。" +
        "用户问某个概念/知识点是什么、问学过的内容时先调用；note 为 no_match 表示知识库没有相关内容，需如实告知。",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe("检索关键词或问题，使用知识点名称效果最好"),
        k: z.number().int().min(1).max(SEARCH_MAX_K).optional().describe(`返回数量，默认 ${SEARCH_DEFAULT_K}，最多 ${SEARCH_MAX_K}`)
      }),
      execute: (input, options) => searchKnowledge(deps, registry, input, options.abortSignal)
    }),

    get_entry: tool({
      description:
        "读取一个知识库词条的完整内容：正文（最多 6000 字）、掌握度、完整度、关联词条与来源条目。" +
        "需要基于当前词条或检索到的词条详细回答（如「这个知识点讲解是否完整」「它和哪些知识点有关」）时使用。",
      inputSchema: z.object({ id: z.string().min(1).describe("词条 id（entryId）") }),
      execute: ({ id }) => getEntry(db, registry, id)
    }),

    get_item: tool({
      description:
        "读取一个收集条目（网页或 AI 问答）的内容：标题、来源 URL、类型、正文或问答内容（最多 6000 字）及关联词条。" +
        "用户针对当前条目提问（如「这篇文章讲了什么」）或需要查看某条学习记录原文时使用。",
      inputSchema: z.object({ id: z.string().min(1).describe("条目 id（itemId）") }),
      execute: ({ id }) => getItem(db, registry, id)
    }),

    list_mastery: tool({
      description:
        "按掌握度列出知识库词条：weak 为掌握薄弱的词条（从最弱开始），familiar 为已熟悉的词条（从最熟悉开始）。" +
        "用户问「哪些知识掌握得不好」「我熟悉哪些知识」或需要给出学习路径建议时使用。",
      inputSchema: z.object({
        level: z.enum(["weak", "familiar"]).describe("weak 薄弱 / familiar 熟悉"),
        limit: z.number().int().min(1).max(MASTERY_LIST_MAX_LIMIT).optional().describe("返回数量，默认 20")
      }),
      execute: (input) => listMastery(db, registry, input)
    }),

    propose_organize: tool({
      description:
        "用户要求整理（把收集内容整理进知识库）时调用，只会向用户展示「整理确认卡片」，不会执行整理。" +
        "target：current 当前页面的条目/知识点（如「帮我整理该页知识点」）；pending 待整理内容；all 全量；selected 用户已选内容；ask 用户没说明范围（如只说「整理」）时让用户在卡片中选择。" +
        "调用后告诉用户请在卡片中确认，绝不能声称已经开始或完成整理。",
      inputSchema: z.object({
        target: z.enum(ORGANIZE_TARGETS).describe("整理范围"),
        requirement: z.string().trim().max(2000).optional().describe("用户提出的整理要求，原样转述，没有则省略")
      }),
      execute: ({ target, requirement }) => {
        const options = resolveOrganizeOptions(context, target, lookups);
        emit({ type: "organize-card", data: { options, ...(requirement ? { requirement } : {}) } });
        return {
          status: "card_shown" as const,
          options: options.map((item) => (item.targetName ? `${item.label}：${item.targetName}` : item.label)),
          note: "已向用户展示整理确认卡片，等待用户在卡片中确认；整理尚未开始，不要声称已开始或已完成整理。"
        };
      }
    }),

    record_learner_profile: tool({
      description:
        "记录用户主动陈述的学习者档案：role 为身份/职业（如「我是产品经理」，覆盖旧值），direction 为近期学习方向（如「我最近在学 AI 相关知识」，追加，30 天有效）。" +
        "只在用户明确陈述自己的身份或学习方向时调用；保存后简短回复「好的，已记录」。",
      inputSchema: z.object({
        role: z.string().trim().max(100).optional().describe("身份或职业"),
        direction: z.string().trim().max(100).optional().describe("近期学习方向")
      }),
      execute: (input) => recordLearnerProfile(db, input, now(), (data) => emit({ type: "profile-card", data }))
    })
  };
};
