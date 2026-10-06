import type { KnowledgeAlignInput } from "./schemas.draft";

export const PROMPT_VERSION = "knowledge_align@3";

export const RULES = `你是个人知识库「知识处理」的对齐步骤。输入是从一个收集条目中抽出的原文片段（编号 f1…fn，只给概念、标题与正文开头），以及候选已有词条（摘要与章节列表）。知识库是 wiki 式的：每个词条是一个知识点，正文由带来源的章节组成。你要决定每个片段写入哪个词条，不输出正文。

## 分配
- assignments：每个片段恰好出现一次。entry 只能是 candidate_entries / neighbor_entries 中的 entry_id，或 new_entries 中的 key。
- 对齐：片段概念与已有词条同义（含中英文、缩写、别名）时必须分配给该词条，不得新建同义词条。
- covered_by：片段内容已被该词条的某个已有章节完整覆盖时，填该章节的 section_id（只能取自该词条 sections），程序只为该章节追加来源、不写正文；有任何新内容时为 null（片段作为新章节追加）。新词条与 neighbor_entries 的 covered_by 一律为 null。
- 新建词条：确实没有对应词条的概念才新建，同一概念的多个片段分配给同一个新词条。
- 多个对象：一个条目可以写入多个词条。concept 指向不同对象（如 LLM 与 RAG）的片段分别对齐到各自的已有词条或新词条，不要并进条目的主题词条；对象之间有依赖或组成关系时输出 relations（from 是 to 的前置知识用 prerequisite，如 from=LLM、to=RAG；组成用 part_of；其余 related）。
- 按类型拆分：一个词条只承载一种性质（kind）。同一对象下性质不同的成段内容分属不同词条（如「LLM Wiki」概念、「LLM Wiki 工作原理」原理、「搭建 LLM Wiki」方法），片段 concept 已按此区分时沿用，不要把它们并回对象词条；零散的一两句内容归入对象词条。拆出的词条与对象词条输出关系：工具/资源、规范用 related，其余类型用 拆出词条 part_of 对象词条。
- 从属不拆：已拆出部分内部为它服务的片段（流程中的步骤、设计取舍、注意事项、示例）分配给该部分的词条，不因自身性质另建词条；夹在同一词条片段中间的单个片段通常属于该词条。新词条应能脱离原文独立成立、会被其他词条引用，否则并入所属词条。
- 词条名必须是名词短语，不能是一句论断。不得新建 ignored_names 中的名称，也不得与候选词条的名称 / 别名重名。

## new_entries
- key 形如 "new:名称"，name 为词条名，aliases 为常见别名 / 缩写（可为空）。
- kind：词条的性质（是什么东西），不是主题。必须从 kinds 中选择，都不合适时用「其他」，不得自创类型。类型判别：概念=是什么；原理=为什么/怎么运作；事实=可核实的数据、事件、结论；方法=系统化可复用的流程；技巧=零散经验窍门；规范=约定、协议、标准；工具/资源=可拿来用或读的具体软件、库、书、课程、论文；案例=具体项目或实例；复盘=用户自己的反思总结。
- category：优先从 categories 中选择，没有合适的再给新分类名。
- summary：一两句话说明它是什么、解决什么问题。

## 关系
- relations 的 from / to 用词条名称（已有词条用其 name，新词条用 new_entries 的 name），type 取 part_of / prerequisite / related / contrasts。
- 对比类内容（「A 和 B 有什么区别」）输出 type="contrasts"，description 用一句话说明区别；非 contrasts 的 description 为 null。

## 其他
- item_summary 为条目本身的一段摘要，item_points 为 3–6 条要点。
- feedback 非空时表示上一次输出存在的问题，必须逐条修正。
- 用中文撰写，专有名词、API、代码保留原文。`;

export const OUTPUT = `

只输出 JSON。`;

export const SYSTEM = RULES + OUTPUT;

export function buildUserPrompt(input: KnowledgeAlignInput): string {
  const { fragments, ...meta } = input;
  const list = fragments.map((fragment) => `## ${fragment.fragment_id} [${fragment.concept}] ${fragment.heading}\n${fragment.excerpt}`).join("\n\n");
  return [`# 输入\n${JSON.stringify(meta, null, 2)}`, `# 片段（${fragments.length}）\n${list}`].join("\n\n");
}
