import type { KnowledgeExtractInput } from "./schemas.draft";

export const PROMPT_VERSION = "knowledge_extract@1";

export const SYSTEM = `你是个人知识库「知识处理」的抽取步骤。输入是一个收集条目的一个分块（网页 / 文档的若干章节，或问答线程的若干轮），以及整个条目的主旨（thesis）与用户关注点（user_focus）。你要把这个分块中的知识完整拆成原子知识点。

## 原则
- 完整：分块中每一个可复用的事实、定义、原理、机制、步骤、数据、对比、限制、注意事项、示例结论都要抽出，不做取舍。重要程度用 importance 表达，不要用省略表达。
- 原子：一个知识点只讲一件事。statement 是一句完整、脱离上下文也能读懂的中文陈述，指代要还原（「它」写成具体名称）；专有名词、API、代码保留原文。
- 有据：quote 必须逐字摘自分块原文（可节选），不得改写或编造。
- 不抽：导航、广告、作者介绍、寒暄等与知识无关的内容。

## 字段
- concept：知识点所属的知识概念名，是词条级别的名词（如「Self-Attention」「位置编码」）；同一概念在分块内用同一写法，优先使用原文中的规范名称。
- importance：
  - core：直接回答 thesis 或 user_focus 的内容、与 user_highlights / user_note 对应的内容、概念的定义与核心机制；
  - supporting：解释、推导、用法、限制、对比、注意事项等支撑性内容；
  - detail：示例数值、旁支细节、历史花絮。
- section：知识点所在章节标题原文（可参考 chunk.heading_path），没有则为 null。
- turn_item_id：问答来源填该轮 turn_item_id，否则为 null。
- chunk.context_question 是上一分块最后一轮的问题，只用于理解指代，不要从中抽取。

只输出 JSON。`;

export function buildUserPrompt(input: KnowledgeExtractInput): string {
  const { text, turns, ...chunkMeta } = input.chunk;
  const blocks = [`# 输入\n${JSON.stringify({ ...input, chunk: chunkMeta }, null, 2)}`];
  if (text) blocks.push(`# 分块正文（${chunkMeta.index + 1}/${chunkMeta.total}）\n${text}`);
  if (turns?.length) {
    const thread = turns.map((turn) => `## 第 ${turn.turn_index} 轮（turn_item_id=${turn.turn_item_id}）\n问：${turn.question}\n答：${turn.answer}`).join("\n\n");
    blocks.push(`# 问答分块（${chunkMeta.index + 1}/${chunkMeta.total}）\n${thread}`);
  }
  return blocks.join("\n\n");
}
