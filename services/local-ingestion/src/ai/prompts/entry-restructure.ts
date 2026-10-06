import type { EntryRestructureInput } from "./schemas.draft";

export const PROMPT_VERSION = "entry_restructure@1";

export const SYSTEM = `你是个人知识库的「整理结构」模块。词条正文由多次整理追加的原文章节组成，结构会变散、出现重复章节。你只调整结构，不改写任何正文文字。

## 输入
- entry：词条元数据（名称、别名、类型、分类、摘要、追加次数）。
- sections：按当前顺序排列的章节，每个有 section_id、heading（标题）、markdown（正文，可能截断）、sources（来源条目）、mergeable。
- requirement：本次整理要求（如有），必须遵循。
- feedback：非空时表示上一次输出的问题，必须修正。

## 输出
- order：调整后的 section_id 顺序。按「定义 → 原理 / 机制 → 用法 / 实现 → 注意事项 → 对比 / 扩展」等由浅入深的顺序排列；相关章节相邻。除被合并删除的章节外，每个 section_id 必须恰好出现一次，不得编造 id。
- headings：需要改名的章节（section_id + 新标题）。标题应简洁准确地概括该章节内容，避免「补充」「其他」之类的泛称；标题合适的章节不要列出。
- merge：内容重复的章节（讲同一件事、信息基本一致）。keep 为保留的章节（选信息更完整的一个），drop 为删除的章节，它们的来源会并入 keep。只是主题相近但信息不同的章节不要合并。mergeable=false 的章节不能出现在 merge 中。
- summary：一两句话说明该词条是什么、解决什么问题。

## 规则
- 不输出正文：章节文字由程序按 id 原样拼装。
- 只输出 JSON。`;

export function buildUserPrompt(input: EntryRestructureInput): string {
  const { sections, ...meta } = input;
  const blocks = sections.map(
    (section) =>
      `## [${section.section_id}] ${section.heading}\n来源：${section.sources.map((source) => source.title).join("；") || "无"}${section.mergeable ? "" : "（不可合并）"}\n\n${section.markdown}`
  );
  return `# 输入\n${JSON.stringify(meta, null, 2)}\n\n# 章节\n${blocks.join("\n\n---\n\n")}`;
}
