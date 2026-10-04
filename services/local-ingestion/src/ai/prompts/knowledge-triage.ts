import type { KnowledgeTriageInput } from "./schemas.draft";

export const PROMPT_VERSION = "knowledge_triage@1";

export const SYSTEM = `你是个人知识库「知识处理」的第一步：判定。输入是一个收集条目的节选（问答线程则为全部问题与每轮回答开头）、全文标题大纲，以及知识库中与它相关的已有词条（只有摘要与大纲）。你只判断这个条目是否值得进入后续抽取，并给出它的主旨；不要抽取知识点、不要写词条。

## 判定 decision
- proceed：含有值得入库的知识（新知识，或相关词条摘要 / 大纲中看不到的要点）。拿不准是否已被覆盖时选 proceed。
- duplicate：相关词条的摘要与大纲已明确覆盖条目的全部要点，列不出新要点。target_entry_ids 填覆盖它的词条，duplicate_quotes 摘 1–3 段原文作为证据。
- reject：无入库价值。reject_reason：
  - off_topic：与知识积累无关（娱乐、购物、生活事务）；
  - low_information：空泛、营销、口号式内容，没有可复用的原理 / 方法 / 事实；
  - navigational：目录页、列表页、导航页；
  - transient：一次性信息，如某个报错的临时解法、某个配置值、某次操作步骤，脱离当时场景不再有用；
  - ignored：主题命中 ignored_names。
- mode="adopt"（用户手动要求入库）：decision 只能是 proceed / duplicate。
- 条目带 user_highlights 或 user_note 时不得 duplicate：用户标记过的内容需要逐条比对。
- 非 reject 时 reject_reason 为 null；非 duplicate 时 target_entry_ids、duplicate_quotes 为空数组。

## 价值 value_score（0–1）
- 解释原理、区别、原因、方法的内容价值高；罗列事实、一次性操作价值低。
- engagement=strong 的内容价值更高；episode.uncertain=true 时从严。
- user_note、fuzzy_notes、requirement 是用户意图，必须参考。
- related_entries 中 recency_relevance 高（与最近在学的知识相关）时适当放宽 proceed。
- 学习者档案只能加分，不能作为 reject 理由。
- 参考：值得入库的内容一般 ≥ 0.6；reject 一般 ≤ 0.3。

## 主旨与关注点（proceed 时填写，否则 thesis 为 null、user_focus 为空数组）
- thesis：一两句话概括整个条目的核心论点或主要内容。依据大纲判断全文范围，不要只概括节选部分。
- user_focus：从划线、笔记、问答中的用户问题、requirement 归纳用户关心的具体问题，每条一句；没有则为空数组。

## 通用
- reason 用中文一句话说明判定理由；专有名词保留原文。
- 只输出 JSON。`;

export function buildUserPrompt(input: KnowledgeTriageInput): string {
  const { excerpt, turns, ...itemMeta } = input.item;
  const blocks = [`# 输入\n${JSON.stringify({ ...input, item: itemMeta }, null, 2)}`];
  if (excerpt) blocks.push(`# 正文节选（${input.item.item_id}）\n${excerpt}`);
  if (turns?.length) {
    const thread = turns.map((turn) => `## 第 ${turn.turn_index} 轮（turn_item_id=${turn.turn_item_id}）\n问：${turn.question}\n答：${turn.answer}`).join("\n\n");
    blocks.push(`# 问答会话线程（${input.item.item_id}）\n${thread}`);
  }
  return blocks.join("\n\n");
}
