# 17 方案（原文为主的整理 + 章节边注 + Agent LLM Wiki 模式）

目标：解决整理产物「重点偏移、内容丢失」（例：问答「llmwiki 是什么？如何搭建」只入库了定义，搭建部分全部丢失）。知识库正文改为**以原文为主**：整理只去除废话、按概念切分原文片段，不再由模型摘要改写；来源与章节备注以边注形式对齐章节展示。Agent 整理改为对齐 LLM Wiki 的对话式流程。本文取代 15 中的判定 / 分块 / 抽取 / 组织写作 / 词条重写部分；16 中的写入工具与 skill 流程以本文为准。

## 范围

| 内容 | 本期 |
| --- | --- |
| 去掉内容判定（triage） | 做 |
| 知识抽取：全文一次调用（不分块），输出按概念切分的清洗后原文片段 | 做 |
| 对齐：片段 → 已有词条 / 新建、是否已覆盖、关系、新词条元数据 | 做 |
| 代码校验：原文一致性、章节完整性（重试 1 次） | 做 |
| 章节标记（id + 来源）存于正文；补充、覆盖、删除级联按章节处理 | 做 |
| 词条重写 → 整理结构（只调序 / 合并标题 / 去重复章节，不改写文字） | 做 |
| 词条页：左正文、右边注（章节来源 + 章节备注），整篇备注在正文下方，图谱与掌握度压缩在正文上方 | 做 |
| 词条备注不再作为整理依据 | 做 |
| Agent：逐篇与用户确认方案，按 LLM Wiki 规范写作；新写入工具 | 做 |
| 超长内容分块抽取 | 不做：`// ponytail:` 单次调用，超出模型上下文时整条失败并记录，出现后再按章节分块 |
| 旧词条迁移（补章节标记） | 不做：无标记的旧章节不显示边注，来源列在边注栏底部「其他来源」 |

## 整理依据（备注）

- 控制整理的有三类：用户在原文上加的**收集箱条目备注**（`scope='item'`）、批量整理时的**模糊备注**（`scope='fuzzy'`）、发起整理时填写的**整理要求**（`origin='organize_requirement'`）。按其中的指令执行，如「剔除 X」→ 删除对应内容，「这部分只留摘要」→ 仅该部分写摘要；不含指令的条目备注作为用户关注点（对应内容必须保留）。
- 词条备注（`scope='entry'`，在知识库文章上加的整篇 / 章节备注）不影响整理，只作为对话问答、检索、Agent 读取知识库时的标识。
- 条目备注整理后不复制到词条（原文备注留在收集箱条目上，词条边注的来源卡片可跳回查看）。
- 用户划线：对应原文必须保留。
- 词条详情页不显示条目备注、模糊备注与整理要求；「待整理提示条」只在正文被编辑时出现，不再统计未使用备注。
- 收集箱条目页的备注与「尚未用于整理」提示保持现状。

## 自动整理流程

```text
③ 学习判定（只判是否学习 / 候选条目 / 投入度 / uncertain；topic、learning_goal 只写入记录，不传给后续）
    ↓
④ 检索与预过滤（不变）
    ↓ route=llm
⑤a 知识抽取 extract     knowledge_processing 模型 · 1 次 · 全文
    ↓ 片段（概念、标题、清洗后原文、turn）
校验 V1                 代码：原文一致性；章节完整性 → 带 feedback 重试 1 次
    ↓
概念召回                每个概念名：名称 / 别名匹配 + 向量召回，与 ④ 合并（≤10）
    ↓
⑤b 对齐 align           knowledge_processing 模型 · 1 次 · 不输出正文
    ↓ 校验 V2：结构问题 → 带 feedback 重试 1 次，仍失败则单元 failed
⑥ 写入                  新建词条 / 追加章节 / 覆盖章节追加来源 / 关系
```

决定推导（代码）：

| 情况 | decision |
| --- | --- |
| 抽取无片段（全部为废话或被备注剔除） | `reject`（`low_information`） |
| 所有片段 `covered` | `duplicate`，目标为覆盖它们的词条 |
| 存在 `new` 词条 | `new` |
| 其余 | `supplement` |

mode=adopt（用户手动要求入库）时无片段 → 单元 `failed`，不判 reject。

### ⑤a 知识抽取

输入（`knowledgeExtractInputSchema`，`step: "extract"`）：`item`（id、type、source_kind、title、url）、全文 `text`（网页 / 文档）或 `turns`（问答，每轮问题 + 完整回答）、`user_highlights`、`instructions`（条目备注 + 模糊备注 + 整理要求，原文列出并标明类别）、`ignored_names`。

输出：

```json
{
  "fragments": [
    {
      "concept": "LLM Wiki",
      "heading": "与传统 RAG 的区别",
      "markdown": "清洗后的原文片段（保留代码块 / 表格 / 图示）",
      "summarized": false,
      "source_section": "## 1. LLM Wiki 到底是什么？",
      "turn_item_id": "…"
    }
  ],
  "removed": [{ "source_section": "…", "reason": "instruction | boilerplate" }]
}
```

规则（prompt 要点）：

- 不是摘要：保留原文措辞与结构；只删除寒暄套话、导航广告、引用图标 / 追踪链接、与知识无关的段落、重复句；可修正明显的排版问题与标题层级。
- 按概念切分：一个片段是原文中连续讲同一概念的一段，`concept` 用词条级名词（不按小节另起名）；同一概念多段可分多个片段。
- 多个对象：一篇原文讲多个独立对象（如 LLM 与 RAG）时，每个有成段讲解的对象各自成为 concept，对齐到各自的已有词条或新词条，并按依赖 / 组成输出关系；同一小节交替讲两个对象时按段落切片段；顺带提及的对象不单列。
- 按类型拆分：一个词条只承载一种性质（内置类型）。同一对象下性质不同、且有成段内容（至少一个完整小节或数段）的部分各自成为独立词条，`concept` 用「对象 + 该部分」命名（如「LLM Wiki」概念、「LLM Wiki 工作原理」原理、「搭建 LLM Wiki」方法、「microsoft/llmwiki」工具/资源）；性质相同的连续小节同一 concept；一两句的零散内容归入对象词条。对齐时拆出词条与对象词条建关系：工具/资源、规范为 `related`，其余为 `part_of`。
- 从属不拆：只在对象之间、或同一对象的顶层方面之间拆；已拆出部分内部为它服务的内容（流程步骤、设计取舍、注意事项、示例）跟随该部分。判断标准：离开原文能否独立成立、会不会被别的词条引用，两者都否就不拆。concept / 词条名必须是名词短语，不能是论断句。
- 拆分校验（V2 一部分，`checkSplit`）：新词条只有一个片段且前后片段属于同一词条（`sandwiched`），或是同篇另一新词条的 `part_of` 子词条且只有一个片段、不足 800 字（`too_small`），或名称超过 40 字 / 含论断词（不需要、应该、如何、为什么…）时，带反馈重试一次；重试后仍存在的前两类由代码并入目标词条（片段改分配、删除该新词条及其关系），记入 raw `split_merged`；命名问题只反馈不强制。
- 指令：`instructions` 要求剔除的内容放入 `removed`（`reason=instruction`）；要求只留摘要的部分输出摘要并置 `summarized=true`。
- 划线对应的原文必须出现在某个片段中。
- `source_section`：片段在原文中所在章节标题原文（无标题为 null）。

### 校验 V1（代码）

- 原文一致性：`summarized=false` 的片段，按字符 bigram 计算「片段 bigram 出现在原文中的比例」，< 0.85 → 视为改写。
- 章节完整性：原文（网页 / 文档按标题切；问答按每轮回答内的标题切）中正文 ≥ 50 字的章节，既无片段的 `source_section` 指向、也不在 `removed` 中 → 遗漏。
- 有改写或遗漏 → 带 feedback 重试 1 次，取问题更少的结果；仍有遗漏写入 trace（`missing_sections`），不阻塞入库。

### ⑤b 对齐

输入（`knowledgeAlignInputSchema`，`step: "align"`）：片段列表（编号 f1…fn、concept、heading、正文前 300 字）、候选词条（id、name、aliases、kind、summary、章节列表：section_id + 标题 + 前 200 字）、`neighbor_entries`、`categories`、`kinds`、`ignored_names`、`feedback`。

输出：

```json
{
  "assignments": [
    { "fragment_id": "f1", "entry": "new:LLM Wiki", "covered_by": null },
    { "fragment_id": "f2", "entry": "kb_abc", "covered_by": "s_7f3a" }
  ],
  "new_entries": [{ "key": "new:LLM Wiki", "name": "LLM Wiki", "aliases": [], "kind": "概念", "category": "知识管理", "summary": "…" }],
  "relations": [{ "from": "LLM Wiki", "to": "RAG", "type": "contrasts", "description": "…" }],
  "item_summary": "…",
  "item_points": ["…"]
}
```

V2 校验：每个片段恰好分配一次；`entry` 只能是候选 / 邻居 id 或 `new_entries` 的 key；`covered_by` 必须是该词条的章节 id；同义新词条不得与候选重名（名称 / 别名归一化比较）；ignored_names 不得新建。

## 词条数据

### 章节标记

每个整理写入的章节以标记行开头，标记存于 `body_markdown`，章节改名、调序不丢：

```markdown
## 与传统 RAG 的区别
<!-- section:s_7f3a src:item_1,item_2 -->
正文…
```

- `section` 为章节 id（`s_` + 8 位随机），`src` 为来源条目 id（可多个）。
- 解析：`## ` 标题后紧跟的标记行；无标记的章节 = 手写 / 旧章节。
- 渲染时剥除标记行；编辑器中原样显示（提示「请勿删除 `<!-- section … -->` 行」）。
- `kb_entry_sources` 保留词条级来源（删除影响、掌握度、来源数）；`evidence` 改存 `[{ section_id, heading }]`。

### 写入（⑥）

| 情况 | 处理 |
| --- | --- |
| 新词条 | 按片段顺序拼成 `## heading` + 标记 + 正文 |
| 已有词条、新片段 | 追加到正文末尾；同一词条多个片段按原文顺序 |
| `covered_by` | 不写正文，该章节标记 `src` 追加本条目 |
| `user_edited` 词条 | 同样追加章节（原文片段不覆盖手写内容），不改已有章节 |

`patch_count` 每次追加 +1；`≥ 8` 时提示「整理结构」。

### 删除来源条目

- 仅来自该条目的章节：整节删除。
- 多来源章节：从 `src` 移除该条目。
- 词条无剩余章节且无手写内容 → 按现有规则删除词条（回收站快照包含删除前正文）。
- 不再设置 `stale` 与触发重写。

### 整理结构（替代词条重写）

- 输入：章节列表（section_id、标题、正文、来源）。输出：`order`（section_id 序列）、`headings`（改名）、`merge`（重复章节：保留者 + 被并者，来源合并）、`summary`。
- 代码按 id 重新拼装正文，文字不变；被并章节删除，来源并入保留章节。
- 触发：补丁数提示条、词条页「整理结构」按钮、整理范围选择词条时。

## 词条页

```text
┌ 面包屑 / 标题 / 操作 ───────────────────────────────┐
│ [关联图谱(压缩) | 掌握程度(压缩)]                     │
├──────────────────────────────┬──────────────────────┤
│ 简介                          │ 边注栏               │
│ ## 章节 A                     │  ├ 来源卡片（A）      │
│ …                             │  └ 章节备注（A）+ 添加 │
│ ## 章节 B                     │  ├ 来源卡片（B）      │
│ …                             │                      │
│ 与 X 的区别 / 常见疑问（渲染）  │ 其他来源（无标记）    │
├──────────────────────────────┴──────────────────────┤
│ 整篇备注 · 同分类词条                                 │
└──────────────────────────────────────────────────────┘
```

- 边注：按章节分组，卡片顶端对齐章节标题；内容重叠时顺延（测量章节 `offsetTop`，`ResizeObserver` 重排）。窄屏（< 1100px）边注折叠到每节末尾。
- 来源卡片：图标、标题、类型、时间、问答问题（跳到对应轮）、「对比原文」。
- 章节备注：`notes` 新增 `anchor`（章节 id）列；`anchor` 为空的词条备注是整篇备注，显示在正文下方。章节被删除时其备注转为整篇备注。
- 去掉独立的「来源与摘录」卡片与侧栏；关联图谱、掌握程度压缩成正文上方一行两卡。
- `completeness.missing` 展示保留（来自旧数据；新流程不再产生）。

## Agent 整理（LLM Wiki 模式）

### Skill 流程（`skillVersion: 3`）

1. `get_guidelines`、`start_session`。
2. `list_inbox` 取单元，逐篇：
   1. `get_unit` 读全文（不分块）、划线、备注。
   2. `search_kb` / `get_entry` 了解相关词条。
   3. **向用户汇报并等待确认**：关键要点；计划新建 / 补充的词条与章节；要剔除的内容；与已有内容的矛盾与关系；或建议不入库及理由。
   4. 用户确认或修改后写入；用户说跳过 → `finish_unit(skipped)`。
3. `finish_session` 汇报。

### 写作规范（`get_guidelines` 返回，与自动流程分开）

对齐 LLM Wiki ingest：Agent 是 wiki 维护者，可综合改写；优先更新已有词条而非新建同义词条；与已有内容冲突时在章节中标注「⚠ 与 X 冲突」并说明；维护词条关系；每个章节标明来源；按用户在对话中的要求取舍。

### 工具

| 工具 | 输入 | 说明 |
| --- | --- | --- |
| `write_entry` | run_id、unit_key、`entry_id` 或 `new: { name, aliases, kind, category, summary }`、`sections: [{ heading, markdown, source_item_ids }]` | 追加章节，服务端生成章节标记 |
| `attach_source` | run_id、unit_key、entry_id、section_id、item_ids | 已覆盖章节追加来源 |
| `add_relation` | run_id、unit_key、from、to、type、description | 建立关系 |
| `finish_unit` | run_id、unit_key、`status: organized \| rejected \| not_learning \| skipped`、reason | 更新条目状态与整理结果 |

- 校验：词条存活、`source_item_ids` 属于该单元、kind 在词表内、新词条不与已有名称 / 别名重名（重名返回 `name_exists` + entry_id）。不校验引文。
- 删除：`submit_decision`、points / compose 校验与相关错误码；`get_unit` 的 `chunks` 改为全文 `text` / `turns`。
- `get_entry` 返回章节列表（section_id、标题、来源）供 `attach_source` 使用。

## 删除 / 改动清单

- 删除：`ai/prompts/knowledge-triage.ts`、`knowledge-compose.ts`、`entry-rewrite.ts`（由 `knowledge-align.ts`、`entry-restructure.ts` 取代）；`organize/chunk.ts` 的抽取分块；`coverage.ts` 改为 V1 / V2 校验；`agent/submit.ts` 改为写入工具实现。
- 修改：`process.ts`、`pipeline.ts`、`integrate.ts`、`rewrite.ts` → `restructure.ts`、`kb/detail.ts`（章节解析、边注数据）、`trash/items.ts` 与 `kb/delete.ts`（按章节级联）、`notes`（anchor 迁移 `008_notes_anchor.sql`）、`RunTrace.tsx`（步骤：知识抽取 / 对齐）、`KbEntryPage.tsx` / `KbEntryBody.tsx`、mock、测试、`skills/organize-kb/SKILL.md` 与 `agent/skill.ts`。
- 文档：07、08、15、16 中被取代部分加指向本文的说明。

## 验收

- llmwiki 问答样本：入库内容包含 11 节中除寒暄外的全部知识章节（搭建、三个 Agent、Schema、MVP 顺序），代码块与示意图保留。
- 条目备注「剔除 Obsidian 部分」生效；模糊备注「第 7 节只留摘要」只摘要该节；在词条上加的备注重新整理时不产生影响。
- 同一知识第二篇来源：不重复写入，对应章节边注出现两个来源。
- 删除一个来源：只属于它的章节消失，共享章节去掉该来源。
- 词条页：边注与章节对齐；章节备注可增删；模糊备注与整理要求不出现。
- Agent：每篇先给方案并等待确认，确认后写入；`write_entry` 生成的章节在词条页显示来源边注。
