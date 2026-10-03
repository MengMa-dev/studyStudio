import type { DatabaseSync } from "node:sqlite";
import { activeDirections, type ChatContext, type ChatPage } from "@study-studio/shared";
import { readLearnerProfile } from "../data/profile.js";
import { getItemDetail } from "../inbox/detail.js";
import { getKbEntryDetail } from "../kb/detail.js";
import { localDay, weekdayLabel } from "../timeline/time.js";

export const CHAT_PROMPT_VERSION = "chat-v1";

/** Prefix the UI keys off for the 「非学习记录」 badge. */
export const NON_RECORD_PREFIX = "以下内容非学习记录";
export const NO_HIT_TEXT = "知识库没有相关内容";

const PAGE_LABELS: Record<ChatPage, string> = {
  home: "首页",
  wiki: "知识库",
  entry: "词条详情",
  progress: "学习进度",
  inbox: "收集箱",
  item: "条目详情",
  runs: "整理记录"
};

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function profileSection(db: DatabaseSync, today: string): string {
  const profile = readLearnerProfile(db);
  const directions = activeDirections(profile, today);
  const lines = [`- 角色：${profile.role || "未填写"}`];
  lines.push(directions.length ? `- 近期学习方向：${directions.map((direction) => direction.text).join("、")}` : "- 近期学习方向：未填写");
  return lines.join("\n");
}

/** Only titles + ids; the model fetches full text with get_entry / get_item when needed. */
export function pageContextSummary(db: DatabaseSync, context: ChatContext): string {
  const lines = [`- 当前页面：${PAGE_LABELS[context.page]}`];
  if (context.entryId) {
    const entry = getKbEntryDetail(db, context.entryId);
    lines.push(entry ? `- 当前词条：「${entry.name}」（id: ${entry.id}）` : `- 当前词条 id：${context.entryId}（已不存在）`);
  }
  if (context.itemId) {
    const item = getItemDetail(db, context.itemId);
    lines.push(item ? `- 当前条目：「${item.title}」（id: ${item.id}）` : `- 当前条目 id：${context.itemId}（已不存在）`);
  }
  if (context.selectedItemIds?.length) lines.push(`- 收集箱已选 ${context.selectedItemIds.length} 条`);
  if (context.selectedEntryIds?.length) lines.push(`- 知识库已选 ${context.selectedEntryIds.length} 个词条`);
  return lines.join("\n");
}

const RULES = `## 回答规则
1. 回答必须基于工具结果（学习记录与知识库）。工具结果中的每个对象带有 ref 序号，引用时在句末用 [n] 标注，n 只能取工具返回过的 ref，不要编造。
2. 回顾学习记录用 query_timeline；问知识点先用 search_knowledge，需要正文时再用 get_entry / get_item；问掌握情况用 list_mastery。
3. 检索没有命中时，明确说「${NO_HIT_TEXT}」。若再用通用知识回答，这部分必须以「${NON_RECORD_PREFIX}」开头。
4. 没有调用任何检索工具、也没有引用的回答，必须以「${NON_RECORD_PREFIX}」开头。
5. 用户要求整理时只能调用 propose_organize 生成确认卡片，不能声称已经整理；范围不明确时 target 用 ask。
6. 用户陈述自己的身份或学习方向（如「我是产品经理」「我最近在学 AI」）时调用 record_learner_profile，然后简短回复「好的，已记录」。
7. 用中文回答，简洁、结构清晰，可用 Markdown 列表。`;

export function buildChatSystemPrompt(db: DatabaseSync, context: ChatContext, now: Date = new Date()): string {
  const today = localDay(now);
  return [
    "你是 Study Studio 的学习助手，帮助学习者回顾学习记录、解答学过的知识、了解掌握情况，并协助发起整理。",
    `## 当前时间\n- 日期：${today}（${weekdayLabel(today)}）\n- 时区：${localTimeZone()}`,
    `## 学习者档案\n${profileSection(db, today)}`,
    `## 页面上下文\n${pageContextSummary(db, context)}`,
    RULES
  ].join("\n\n");
}
