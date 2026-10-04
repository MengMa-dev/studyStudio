# 15 方案与实施计划（多轮知识处理）

目标：把 ⑤ 知识处理从「一次调用完成判定 + 抽取 + 对齐 + 写作」改为参考 LLM Wiki ingest 的多轮流水线（判定 → 全文分块抽取 → 组织写作 → 覆盖校验），解决整理产物**丢内容**与**重点不对**；词条重写同步改为基于知识点并做覆盖校验。存储不变（SQLite），⑥ 入库逻辑基本不动。

## 范围

| 内容 | 本期 |
| --- | --- |
| S1 判定（小模型）：proceed / duplicate / reject + 主旨 + 用户关注点 | 做 |
| 全文分块（网页 / 文档按章节，问答按轮）+ S2 逐块抽取原子知识点（小模型，块间并行） | 做 |
| 按概念名逐个检索候选词条 | 做 |
| S3+S4 组织写作（强模型）：知识点 → 词条分配、补丁 / 新词条、舍弃理由 | 做 |
| S5 覆盖校验 + 有上限的重试（结构问题 1 次、遗漏 1 次） | 做 |
| 用户标记（划线 / 笔记）的条目 S1 不得判 duplicate | 做 |
| 知识点随 evidence 持久化（`kb_entry_sources.evidence` JSON 扩字段，无迁移） | 做 |
| 词条重写改为基于知识点 + 覆盖校验 | 做 |
| 通用动态编排（LLM 决定回退到哪个节点） | 不做：只保留代码判定的有限回路（见「有限回路」） |
| 整理中 web search 补充知识 | 不做：违背「只写有依据的内容」；补全 / 核实留给 MCP agent |
| 知识库定期 lint（矛盾、孤立词条、缺失链接） | 不做：后续随 MCP 方案由 agent 执行 |
| 规划阶段超预算时按词条分组多次调用 | 不做：候选词条正文按预算截断（见 S3+S4 ponytail 注） |

## 现状问题

| 问题 | 位置 |
| --- | --- |
| 正文 > 10k token 时只取 3k 节选判定，再只抽 `focus_sections` + 高露出章节（≤ 10k），其余章节不进模型；07 写的 map-reduce 未实现 | `process.ts` `buildExcerpt` / `buildFocusContent` / `processUnit` |
| 一次调用做 5 件事，抽取与写作混在一起；prompt「长文只抽有价值的部分」「简洁准确」鼓励压缩 | `ai/prompts/knowledge-processing.ts` |
| 候选词条按整条召回 top 5、仅前 2 个附正文；新概念不单独检索 → 补丁错位 / 重复 | `process.ts` `MAX_RELATED` / `RELATED_WITH_BODY` |
| 重写证据按条数截 60 条，可能丢要点；无覆盖校验 | `rewrite.ts` `MAX_EVIDENCE` |

## 总体流程

```text
④ Retrieve & Prefilter（不变）
    ↓ route=llm
S1 判定 triage            小模型 · 1 次        节选(≤3k) + 大纲 + 相关词条摘要
    ├─ reject / duplicate / τ 兜底 → ⑥（结束，强模型 0 次）
    ↓ proceed（thesis, user_focus）
分块 chunk                代码                 网页/文档：按章节 ≤6k；问答：按轮 ≤6k
    ↓
S2 抽取 extract           小模型 · 每块 1 次 · 并发 3     → 原子知识点（代码编号 p1…pn）
    ↓
概念检索                  embedding           每个概念名召回已有词条，与 ④ 结果合并（≤10）
    ↓
S3+S4 组织写作 compose    强模型 · 通常 1 次   知识点分配 + 补丁 / 新词条 + dropped
    ↓
S5 校验                   代码                结构错误 → 带 feedback 重试 1 次
                                              core/supporting 遗漏 → 带 feedback 重试 1 次（取遗漏更少的结果）
    ↓
组装为 KnowledgeProcessingOutput → ⑥ 入库（不变，evidence 多存 point / importance）
```

调用次数：

| 类型 | 小模型 | 强模型 |
| --- | --- | --- |
| reject / duplicate | 1 | 0 |
| 短内容（1 块） | 2 | 1（最坏 3） |
| 长文（N 块） | 1 + N | 1（最坏 3） |

条目间仍串行（07「按条目串行」不变）；并行只发生在单条目内的 S2 分块。

## 模型路由

不新增 AI 任务配置，复用现有任务的模型：

| 步骤 | gateway `task` | 说明 |
| --- | --- | --- |
| S1 判定、S2 抽取 | `learning_judge` | 设置页「学习判定」所配的小模型 |
| S3+S4 组织写作、重试 | `knowledge_processing` | 设置页「知识处理」所配的强模型 |
| 词条重写 | `entry_rewrite` | 不变 |

`// ponytail: S1/S2 借用 learning_judge 的模型配置；需要单独调参时再在 AI_TASKS 加 knowledge_triage / knowledge_extract（带回退）。`

进度 stage 全部沿用 `knowledge_processing`，`OrganizeStage` / 共享类型不改。

## S1 判定（triage）

职责：门卫。只回答「值不值得往下走、重点是什么」，不抽取、不写作。与 ③ 学习判定的区别：③ 看行为、按片段、不读正文；S1 看内容 + 知识库、按处理单元。

### 输入（`knowledgeTriageInputSchema`）

| 字段 | 内容 |
| --- | --- |
| `step` | `"triage"`（replay 测试按它匹配） |
| `mode` | `normal` / `adopt` |
| `episode` | 片段主题、学习目标、`uncertain`（手动整理为 null） |
| `learner_profile` | 角色、近期学习方向 |
| `item` | `item_id`、`type`、`source_kind`、`title`、`url?`、**`outline`（全文标题大纲，新增）**、`excerpt?`（网页 / 文档：≤3k 用全文，否则 `buildExcerpt`）、`turns?`（问答：全部问题 + 每轮回答前 400 token）、`user_highlights`、`user_note`、`fuzzy_notes`、`requirement`、`engagement` |
| `related_entries` | ④ 的 top 5：`entry_id`、`name`、`aliases`、`kind`、`summary`、`similarity`、`recency_relevance`、`outline`（不附正文） |
| `ignored_names` | 忽略列表（≤100） |

### 输出（`knowledgeTriageOutputSchema`）

```json
{
  "item_id": "item_B",
  "decision": "proceed",
  "value_score": 0.8,
  "reason": "讲清了正弦位置编码的推导与相对位置性质",
  "reject_reason": null,
  "target_entry_ids": [],
  "duplicate_quotes": [],
  "thesis": "Transformer 用正弦位置编码为无序的 Self-Attention 注入位置信息，并能外推到更长序列",
  "user_focus": ["为什么用 sin/cos", "相对位置如何体现"]
}
```

### 代码侧处理（顺序执行）

1. `mode=adopt` 且 `reject` → 改为 `proceed`。
2. 条目有划线或笔记且 `duplicate` → 改为 `proceed`（误杀代价更大，交给 S3+S4 逐条比对）。
3. `duplicate` 但 `target_entry_ids` 无一存在 → 改为 `proceed`。
4. `proceed` 且非 adopt：τ 兜底 `applyValueScoreFallback({ decision: "new", value_score, engagement, uncertain })`，命中 → `reject`（`low_information`），不进入 S2。
5. `reject` → ⑥ `recordRejection`；`duplicate` → ⑥ `recordDuplicate`，evidence 用 `duplicate_quotes`（为空时用首条划线 / 节选首段，同现有 `excerptEvidence`）。
6. `proceed` 但 `thesis` 为空 → 用 `title` 兜底。

## 分块（chunk）

新文件 `domains/organize/chunk.ts`，纯函数。

| 来源 | 规则 |
| --- | --- |
| 网页 / 文档 | `chunkText(annotateExposure(body), { targetTokens: 6000, maxTokens: 8000, overlapTokens: 0 })`（复用 `search/chunk.ts`，按段落 / 标题边界合并）；每块附 `heading_path`（块起点所在的标题栈，跳过代码围栏内的 `#` 行） |
| 问答线程 | 按轮顺序装箱到 6k；**一轮的问题与回答不拆**；单轮超 6k 独占一块；每块附 `context_question` = 上一块最后一轮的问题 |
| 短内容 | 自然只有 1 块 |

`// ponytail: 单轮问答超 6k 不再切分，出现超长回答再按段落切。`

```ts
export const CHUNK_TOKENS = 6_000;
export type ContentChunk = {
  index: number;          // 0-based
  total: number;
  heading_path: string[];
  text: string | null;    // 网页 / 文档
  turns: Array<{ turn_item_id: string; turn_index: number; question: string; answer: string }> | null;
  context_question: string | null;
};
export function chunkUnit(unit: WorkUnit): ContentChunk[];
```

## S2 抽取（extract）

职责：把分块完整拆成原子知识点，**只抽不取舍**，重要性用 `importance` 表达。

### 输入（`knowledgeExtractInputSchema`）

```json
{
  "step": "extract",
  "item": { "item_id": "item_B", "type": "document", "source_kind": "official_doc", "title": "…" },
  "thesis": "…",
  "user_focus": ["…"],
  "user_highlights": ["…"],
  "user_note": null,
  "chunk": { "index": 1, "total": 3, "heading_path": ["# Transformer", "## Positional Encoding"], "text": "…", "turns": null, "context_question": null }
}
```

### 输出（`knowledgeExtractOutputSchema`）

```json
{
  "points": [
    {
      "statement": "正弦位置编码对偶数维使用 sin、奇数维使用 cos，波长按维度几何递增",
      "quote": "PE(pos,2i) = sin(pos/10000^(2i/d_model))",
      "section": "## Positional Encoding",
      "concept": "位置编码",
      "importance": "core",
      "turn_item_id": null
    }
  ]
}
```

### 代码侧处理

- 并发 3（`mapLimit`）；单块失败重试 1 次，仍失败则整个单元失败（缺块 = 丢内容，不静默降级）。
- 按块顺序合并，编号 `p1…pn`；问答来源由 `turn_item_id` 回填 `question`。
- `user_marked`：`quote` 与任一划线互相包含（归一化空白后）→ `importance` 强制为 `core`。
- 0 个知识点：非 adopt → `reject`（`low_information`）；adopt → 单元失败。

```ts
export type KnowledgePoint = {
  id: string;                         // p1…
  statement: string;
  quote: string;
  section: string | null;
  concept: string;
  importance: "core" | "supporting" | "detail";
  turn_item_id: string | null;
  question: string | null;
};
```

## 概念检索

对知识点中去重后的每个 `concept`：

1. 名称归一化精确匹配已有词条名 / 别名（`findEntryByName`）→ 相似度记 1。
2. `tryEmbed(concept)` → `vectorRecall(indexCtx, vector, [ENTRY_OWNER.name, ENTRY_OWNER.summary], 3)`，保留 ≥ 0.55。
3. 与 ④ 的 `related_entries` 合并去重，按相似度降序保留 ≤ 10 个候选（`MAX_CANDIDATES`）。
4. 按顺序给候选附正文，直到正文累计超过 12k token（`CANDIDATE_BODY_BUDGET`），之后的候选只给摘要 + 大纲。
5. 邻居词条 `neighbor_entries` 沿用 `neighborEntries(db, candidateIds)`。

`// ponytail: 候选正文按 12k 预算截断，超出部分只给大纲；词条正文普遍很长时再按词条分组多次 compose。`

## S3+S4 组织写作（compose）

职责：把每个知识点分配到词条，写补丁 / 新词条正文，未写入的给出舍弃理由。对应 LLM Wiki 的「读 index → 找受影响页面 → 逐页编辑」。

### 输入（`knowledgeComposeInputSchema`）

| 字段 | 内容 |
| --- | --- |
| `step` | `"compose"` |
| `mode`、`learner_profile` | 同 S1 |
| `item` | `item_id`、`type`、`source_kind`、`title`、`thesis`、`user_focus`、`requirement` |
| `points` | `[{ id, statement, concept, importance, section }]`（不含 quote，省 token、防止模型改写引用） |
| `candidate_entries` | `[{ entry_id, name, aliases, kind, summary, outline, body_markdown? }]` |
| `neighbor_entries`、`categories`、`kinds`、`ignored_names` | 同现有 ⑤ |
| `feedback` | 重试时上一次输出的问题列表，否则 null |

User prompt 与现有一致：元数据 JSON + 知识点列表 Markdown 块 + 每个附正文的候选词条一个 Markdown 块。

### 输出（`knowledgeComposeOutputSchema`）

```json
{
  "item_summary": "…",
  "item_points": ["…"],
  "concepts": [
    {
      "name": "位置编码", "match": "new", "aliases": ["Positional Encoding"], "kind": "方法",
      "point_ids": ["p1", "p2", "p5"],
      "patch": null,
      "category": "LLM 基础", "summary": "…", "body_markdown": "## 定义\n…", "completeness": { "covered": ["…"], "missing": ["…"] }
    },
    {
      "name": "Self-Attention", "match": "kb_self_attention", "aliases": [], "kind": "概念",
      "point_ids": ["p3"],
      "patch": { "ops": [{ "op": "append_to_section", "section": "## 局限", "markdown": "…" }], "summary": null, "completeness": null },
      "category": null, "summary": null, "body_markdown": null, "completeness": null
    }
  ],
  "relations": [{ "from": "位置编码", "to": "Transformer", "type": "part_of", "description": null }],
  "dropped": [{ "point_id": "p4", "reason": "covered", "entry_id": "kb_transformer" }]
}
```

### 拆分规则（写入 prompt，部分由 S5 校验）

| 规则 | 校验方 |
| --- | --- |
| 每个 core / supporting 知识点二选一：出现在某个概念的 `point_ids`，或在 `dropped` 中给出理由；detail 可忽略 | S5 代码 |
| 一个知识点只分给一个主词条，跨词条联系用 `relations` | prompt |
| 只有含 core 知识点的概念能新建词条（整个单元没有 core 知识点时除外） | S5 代码 |
| 已有词条：只写增量；分到的知识点都已被正文覆盖时 `patch=null`（仍记为来源） | prompt；⑥ 已支持无 ops → `duplicate` 变更 |
| 正文按词条风格重写，原文片段作为 evidence 追溯 | prompt；evidence 由代码从知识点生成 |
| 同义概念必须对齐已有 `entry_id`，`match` 只能是输入中出现过的 id 或 `"new"` | S5 代码 + ⑥ `decideAlignment` 兜底 |

## S5 校验与组装

新文件 `domains/organize/coverage.ts`，纯函数。

```ts
/** 结构问题（返回给模型的中文 feedback），空数组 = 通过。 */
export function validateCompose(out: KnowledgeComposeOutput, points: KnowledgePoint[], knownEntryIds: Set<string>): string[];
/** core / supporting 中既未写入也未 dropped 的知识点。 */
export function missingPoints(out: KnowledgeComposeOutput, points: KnowledgePoint[]): KnowledgePoint[];
/** 组装为 ⑥ 需要的结果。 */
export function assembleResult(
  out: KnowledgeComposeOutput, points: KnowledgePoint[], meta: { item_id: string; value_score: number; reason: string }
): KnowledgeProcessingOutput;
```

`validateCompose` 检查：引用了不存在的 `point_id`；`match` 既非 `"new"` 也不在 `knownEntryIds`（候选 + 邻居）；`match="new"` 缺 `summary` / `body_markdown` / `category`；新建概念不含 core 知识点（单元内存在 core 时）；已有词条概念 `patch` 与 `body_markdown` 同时非空。

「写入」的定义：概念 `match="new"`，或 `match` 为已有词条且 `patch` 非空，或 `match` 为已有词条且 `patch=null`（视为该知识点已被该词条覆盖）。

`assembleResult`：

- 概念 evidence = 其 `point_ids` 对应知识点 → `{ quote, question, turn_item_id, point: statement, importance }`。
- 存在写入内容的概念（新建或有 patch）：`decision = 有新建 ? "new" : "supplement"`，`concepts` / `relations` / `item_summary` / `item_points` 原样带入（`patch=null` 的已有词条概念也带入，⑥ 记为 duplicate 变更并挂来源）。
- 没有任何写入内容：`decision = "duplicate"`，`target_entry_ids` = 概念的 `match` ∪ `dropped(covered).entry_id`，evidence 取对应知识点；两者都为空 → `reject`（`low_information`）。

### 编排（`process.ts` `processUnit`）

```ts
const first = await compose(input);
let out = first;
let problems = validateCompose(out, points, known);
if (problems.length) {
  out = await compose({ ...input, feedback: problems });
  problems = validateCompose(out, points, known);
  if (problems.length) throw new Error(`compose invalid: ${problems.join("; ")}`);
}
let missing = missingPoints(out, points);
if (missing.length) {
  const retry = await compose({ ...input, feedback: [missingFeedback(missing)] });
  if (validateCompose(retry, points, known).length === 0 && missingPoints(retry, points).length < missing.length) {
    out = retry;
    missing = missingPoints(out, points);
  }
}
// raw 记录 missing_after_retry: missing.map((p) => p.id)
```

`missingFeedback`：`以下要点未写入任何词条，也未在 dropped 中说明理由，请分配或说明：p3「…」；p7「…」`。

## 有限回路

| 情况 | 处理 | 上限 |
| --- | --- | --- |
| S2 单块调用失败 | 重跑该块 | 1 次，仍失败则单元 `failed` |
| compose 结构校验不通过 | 带 feedback 重跑 compose | 1 次，仍不通过则单元 `failed` |
| core / supporting 遗漏 | 带 feedback 重跑 compose，取遗漏更少的结果 | 1 次，剩余遗漏记入 `organize_results.output` |
| 重写遗漏 core / supporting | 带 feedback 重跑重写，取遗漏更少的结果 | 1 次 |

用量超限（`UsageLimitExceededError`）与取消（`OrganizeAbortedError`）照旧向上抛出（暂停 / 中止整批）。

## 存储与记录

- 无迁移。`StoredEvidence` 增加可选字段：

```ts
export type StoredEvidence = { quote: string; question?: string; turnItemId?: string; point?: string; importance?: "core" | "supporting" | "detail" };
```

- `KnowledgeProcessingOutput` 的 evidence schema 增加 `point` / `importance`（nullable）。该 schema 不再直接用于 LLM 输出，只作为 S1–S5 组装后交给 ⑥ 的内部类型。
- `organize_results.output.raw = { triage, chunks: N, points, compose, compose_retries, missing_after_retry }`。
- `PROCESSING_PROMPT_VERSION = "organize@3(triage@1+extract@1+compose@1)"`；进入 `input_hash`，上线后已整理条目在「整理全部」时会重跑。
- `organize_results.prompt_version` 记录同一字符串；`model` 记录 compose 的模型（S1 终止时记录 S1 的模型）。

## 词条重写（基于知识点）

### 输入变化（`entryRewriteInputSchema.evidence[]`）

| 字段 | 说明 |
| --- | --- |
| `id` | `e1…`，代码编号 |
| `point` | 知识点陈述；旧数据无此字段时为 null（模型以 `quote` 作为要点） |
| `importance` | 旧数据按 `supporting` |
| 其余 | `item_id`、`source_kind`、`title`、`quote`、`question` 不变 |

排序：`importance`（core → supporting → detail）→ 来源可靠性；截断从「60 条」改为「累计 16k token」（`REWRITE_EVIDENCE_TOKENS`），截掉的只会是排在最后的 detail。

### 输出变化

```ts
export const entryRewriteOutputSchema = z.object({
  body_markdown: z.string(),
  summary: z.string(),
  completeness,
  covered_ids: z.array(z.string()).describe("正文已写入的 evidence id"),
  dropped: z.array(z.object({ id: z.string(), reason: z.enum(["redundant", "unreliable"]) }))
});
```

代码：`required = evidence 中 importance ∈ {core, supporting}`；`missing = required − covered_ids − dropped.id`；非空 → 带 `feedback` 重跑 1 次，取遗漏更少者。输入 schema 增加 `feedback: string[] | null`。

## Prompt

### `knowledge-triage.ts`（`PROMPT_VERSION = "knowledge_triage@1"`）

```text
你是个人知识库「知识处理」的第一步：判定。输入是一个收集条目的节选（问答线程则为全部问题与每轮回答开头）、全文标题大纲，以及知识库中与它相关的已有词条（只有摘要与大纲）。你只判断这个条目是否值得进入后续抽取，并给出它的主旨；不要抽取知识点、不要写词条。

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

## 价值 value_score（0–1）
- 解释原理、区别、原因、方法的内容价值高；罗列事实、一次性操作价值低。
- engagement=strong 的内容价值更高；episode.uncertain=true 时从严。
- user_note、fuzzy_notes、requirement 是用户意图，必须参考。
- related_entries 中 recency_relevance 高时适当放宽 proceed。
- 学习者档案只能加分，不能作为 reject 理由。
- 参考：值得入库的内容一般 ≥ 0.6；reject 一般 ≤ 0.3。

## 主旨与关注点（proceed 时填写，否则 thesis 为 null、user_focus 为空数组）
- thesis：一两句话概括整个条目的核心论点或主要内容。依据大纲判断全文范围，不要只概括节选部分。
- user_focus：从划线、笔记、问答中的用户问题、requirement 归纳用户关心的具体问题，每条一句；没有则为空数组。

## 通用
- reason 用中文一句话说明判定理由；专有名词保留原文。
- 只输出 JSON。
```

### `knowledge-extract.ts`（`PROMPT_VERSION = "knowledge_extract@1"`）

```text
你是个人知识库「知识处理」的抽取步骤。输入是一个收集条目的一个分块（网页 / 文档的若干章节，或问答线程的若干轮），以及整个条目的主旨（thesis）与用户关注点（user_focus）。你要把这个分块中的知识完整拆成原子知识点。

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

只输出 JSON。
```

### `knowledge-compose.ts`（`PROMPT_VERSION = "knowledge_compose@1"`）

```text
你是个人知识库「知识处理」的组织与写作步骤。输入是从一个收集条目中抽出的全部知识点（带 id、所属概念、重要度）、条目主旨（thesis）与用户关注点（user_focus），以及候选已有词条（摘要、大纲，部分附正文）。知识库是 wiki 式的：每个词条是一个知识点，正文为 Markdown。你要把知识点分配到词条，并写出补丁或新词条正文。

## 分配
- 每个 core / supporting 知识点必须二选一：写入某个词条（出现在该词条的 point_ids 中），或列入 dropped 并给出 reason。detail 知识点可以并入词条，也可以忽略。
- 一个知识点只分配给一个主词条；与其他词条的联系用 relations 表达，不要在多个词条正文中重复同一内容。
- 对齐：概念与 candidate_entries / neighbor_entries 中的词条同义（含中英文、缩写、别名）时，match 必须填该 entry_id，不得新建同义词条。match 只能是输入中出现过的 entry_id 或 "new"。
- 新建词条：只有包含 core 知识点的概念才能新建（所有知识点都不是 core 时除外）；只有 supporting / detail 知识点的概念并入最相关的已有词条或本次新建词条。
- dropped.reason：covered（已有词条正文已写过，entry_id 填该词条）、trivial（价值过低）、off_topic（与知识无关）、unreliable（与可靠来源冲突或明显错误）；非 covered 时 entry_id 为 null。
- 不得对齐或新建 ignored_names 中的名称。
- 对比类内容（「A 和 B 有什么区别」）不新建「对比」词条，输出 type="contrasts" 的 relation，description 用一句话说明区别。relations 的 from / to 用词条名称（已有词条用其 name），type 取 part_of / prerequisite / related / contrasts，非 contrasts 的 description 为 null。

## 写作
- 已有词条（match 为 entry_id）：有新增内容时写 patch，只写增量，不重复正文已有内容，保持原有结构与语气；分到的知识点都已被正文覆盖时 patch 为 null。category、summary、body_markdown、completeness 为 null。
  - ops：append_to_section（section 必须是该词条 outline 中的标题原文）、add_section（在 after 章节之后新增章节）、replace_section（仅用于修正冲突或错误）。
  - 与原文冲突时以 official_doc / repo 为准，ai_answer 来源不得覆盖文档来源的内容。
  - patch.summary 只在摘要需要变化时输出，否则 null；patch.completeness 给出补丁后已覆盖 / 仍缺失的方面，无法判断时为 null。
- 新词条（match="new"，patch 为 null）：
  - category：优先从 categories 中选择，没有合适的再给新分类名；
  - kind：词条的性质（是什么东西），不是主题。优先从 kinds 中选择；都明显不合适时才给 2–6 字中文名词，不得与 kinds 中已有类型同义，不得用主题名；
  - summary：一两句话说明它是什么、解决什么问题；
  - body_markdown：用「## 」二级标题分节（如 定义 / 原理 / 用法 / 注意事项）。按 thesis 与 user_focus 决定主次：core 知识点展开写，supporting 知识点完整写入，不得省略；
  - completeness：covered 为已覆盖的方面，missing 为该主题重要但条目未涉及的方面。
- 正文只写分到的知识点中有依据的内容，可以重组语言，不得编造。
- 不输出「与 X 的区别」「常见疑问」段落（由程序渲染）。

## 其他
- item_summary 为条目本身的一段摘要，item_points 为 3–6 条要点。
- feedback 非空时表示上一次输出存在的问题，必须逐条修正。
- 用中文撰写，专有名词、API、代码保留原文。只输出 JSON。
```

### `entry-rewrite.ts`（`PROMPT_VERSION = "entry_rewrite@2"`）变更

在现有 SYSTEM 上修改：

- 「素材」中 evidence 一条改为：`evidence：该词条现存来源的知识点，每条有 id、point（知识点陈述，可能为 null，此时以 quote 为要点）、importance、quote 与来源可靠性；已按重要度、可靠性排序。`
- 「规则」新增：
  - `每个 importance 为 core / supporting 的 evidence 必须二选一：写入正文并把 id 列入 covered_ids，或列入 dropped（redundant：与其他要点重复；unreliable：与更可靠来源冲突）。`
  - `feedback 非空时表示上一次输出遗漏的要点，必须补上。`
- 删除「保持简洁准确」，改为「准确完整，合并重复但不省略要点」。

## 测试

| 文件 | 用例 |
| --- | --- |
| `test/organize/chunk.test.ts`（新） | 短正文 1 块；三个约 4k 章节 → ≥2 块且每块 ≤ 8k、`heading_path` 正确、所有块拼接后非空白字符与原文一致；代码围栏内的 `# comment` 不进入 `heading_path`；问答 5 轮超预算 → 按轮装箱、一轮问答不拆、`context_question` 正确 |
| `test/organize/coverage.test.ts`（新） | `missingPoints`（detail 不计、dropped 计入、`patch=null` 的已有词条计入）；`validateCompose` 各错误；`assembleResult` 的 new / supplement / duplicate / reject 分支、evidence 带 `point` / `importance` / `question` |
| `test/organize/pipeline.test.ts`（改） | 现有用例迁移为 triage + extract + compose 三段 replay；新增：triage reject 不调 extract；有划线的条目 triage 判 duplicate 仍进入 compose；长文 3 块 → 3 次 extract 且每块内容进入输入；首次 compose 遗漏 p2 → 第二次 compose 带 feedback 并采用；triage τ 兜底 → reject 且无 extract |
| `test/organize/worker.test.ts`（改） | 替换 `replay.process` |
| `test/kb/kb.test.ts` 或重写相关用例（改） | 重写输入带 `id` / `point` / `importance`；遗漏 → 带 feedback 重跑 |

全量：`npm test`、`npm run typecheck`。

---

# 实施计划

前置：当前工作区有未提交的 organize / kb 改动（动态类型、图谱等）。先提交或单独分支保存，再开始本计划，避免与 `process.ts` / `integrate.ts` / `rewrite.ts` 的改动混在一起。

单测命令（单文件）：`node --import tsx --test services/local-ingestion/test/organize/<file>.test.ts`

## Task 1：Schema 与 Prompt

**Files**
- Modify：`services/local-ingestion/src/ai/prompts/schemas.draft.ts`
- Create：`services/local-ingestion/src/ai/prompts/knowledge-triage.ts`、`knowledge-extract.ts`、`knowledge-compose.ts`
- Modify：`services/local-ingestion/src/ai/prompts/entry-rewrite.ts`、`index.ts`
- Delete：`services/local-ingestion/src/ai/prompts/knowledge-processing.ts`

**Produces**
- `knowledgeTriageInputSchema` / `knowledgeTriageOutputSchema` / `knowledgeTriageAdoptOutputSchema`（decision 仅 proceed / duplicate）
- `knowledgeExtractInputSchema` / `knowledgeExtractOutputSchema`，`POINT_IMPORTANCE = ["core", "supporting", "detail"] as const`
- `knowledgeComposeInputSchema` / `knowledgeComposeOutputSchema`，`DROP_REASONS = ["covered", "trivial", "off_topic", "unreliable"] as const`
- `KnowledgeProcessingOutput` 的 evidence 增加 `point` / `importance`（nullable）
- `entryRewriteInputSchema`：evidence 增加 `id` / `point` / `importance`，顶层增加 `feedback`；`entryRewriteOutputSchema` 增加 `covered_ids` / `dropped`
- `PROMPTS` 键：`learning_judge`、`knowledge_triage`、`knowledge_extract`、`knowledge_compose`、`entry_rewrite`；每项增加 `task: GenerativeAiTask`（triage / extract → `learning_judge`，compose → `knowledge_processing`）

所有可选字段用 `nullable`（多家 provider 的 structured output 兼容，见 schemas.draft 头注释）。

- [ ] 按「S1 / S2 / S3+S4 / 词条重写」各节定义 schema（字段与上文一致）
- [ ] 写三个 prompt 文件（SYSTEM 用上文原文；`buildUserPrompt`：元数据 JSON + 长文本 Markdown 块，同现有 `knowledge-processing.ts` 写法；extract 把 `chunk.text` / `chunk.turns` 放 Markdown 块；compose 把 `points` 渲染为 `- p1 [core][位置编码] …`、附正文的候选词条各一块）
- [ ] 更新 `entry-rewrite.ts`（按上文变更）与 `index.ts`
- [ ] `npm run typecheck`：预期仅 `process.ts` / `rewrite.ts` / 脚本报错（下个任务修）
- [ ] Commit：`feat(organize): multistep prompts and schemas`

## Task 2：分块

**Files**
- Create：`services/local-ingestion/src/domains/organize/chunk.ts`
- Test：`services/local-ingestion/test/organize/chunk.test.ts`

**Consumes**：`chunkText` / `estimateTokens`（`search/chunk.ts`）、`annotateExposure`（`process.ts`，移出到 `chunk.ts` 并在 `process.ts` 重新导入）、`WorkUnit`

**Produces**：`CHUNK_TOKENS`、`ContentChunk`、`chunkUnit(unit: WorkUnit): ContentChunk[]`

- [ ] 写失败测试（「测试」表四个用例）。拼接校验：

```ts
const strip = (s: string) => s.replace(/\s+/g, "");
assert.equal(strip(chunks.map((c) => c.text).join("")), strip(body));
```

- [ ] 运行，确认失败
- [ ] 实现：文本走 `chunkText(..., { targetTokens: CHUNK_TOKENS, maxTokens: 8000, overlapTokens: 0 })`；逐块扫描行维护标题栈（遇到 ``` 切换围栏状态，围栏内不识别标题），块起点的标题栈即 `heading_path`；问答按轮装箱
- [ ] 运行，确认通过
- [ ] Commit：`feat(organize): content chunking for extraction`

## Task 3：覆盖校验与组装

**Files**
- Create：`services/local-ingestion/src/domains/organize/coverage.ts`
- Test：`services/local-ingestion/test/organize/coverage.test.ts`

**Produces**：`KnowledgePoint`、`validateCompose`、`missingPoints`、`missingFeedback(points: KnowledgePoint[]): string`、`assembleResult`（签名见「S5 校验与组装」）

- [ ] 写失败测试（「测试」表用例）。示例：

```ts
const points = [pt("p1", "core"), pt("p2", "supporting"), pt("p3", "detail")];
const out = compose({ concepts: [concept({ match: "new", point_ids: ["p1"] })], dropped: [] });
assert.deepEqual(missingPoints(out, points).map((p) => p.id), ["p2"]);
```

- [ ] 运行，确认失败
- [ ] 实现
- [ ] 运行，确认通过
- [ ] Commit：`feat(organize): compose validation, coverage and assembly`

## Task 4：多轮编排接入流水线

**Files**
- Modify：`services/local-ingestion/src/domains/organize/process.ts`（重写 `processUnit`，删除长文两步路径、`LONG_JUDGE_*`、`buildFocusContent`）
- Modify：`services/local-ingestion/src/domains/organize/pipeline.ts`（`ProcessingContext` 传入 `indexCtx`；无其他行为变化）
- Modify：`services/local-ingestion/src/domains/organize/integrate.ts`（`StoredEvidence` / `toStoredEvidence` 存 `point` / `importance`）
- Modify：`services/local-ingestion/test/organize/helpers.ts`、`pipeline.test.ts`、`worker.test.ts`

**Consumes**：Task 1–3 全部导出；`vectorRecall` / `ENTRY_OWNER`；`findEntryByName`；`applyValueScoreFallback`

**Produces**：`processUnit(ctx, unit, related, entriesById): Promise<ProcessOutcome>`（签名不变，`route` 恒为 `"llm"`）；`PROCESSING_PROMPT_VERSION` 新值

`processUnit` 步骤：`buildTriageInput` → `callLlm(task: PROMPTS.knowledge_triage.task)` → 「S1 代码侧处理」→ `chunkUnit` → `mapLimit(chunks, 3, extractWithRetry)` → 编号 / `user_marked` → `conceptCandidates` → compose 编排（见「S5 校验与组装 · 编排」）→ `assembleResult`。

```ts
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}
```

测试辅助（`helpers.ts`）：

```ts
triage(itemId: string, out: unknown, when: (input: Input) => boolean = () => true): MockRule {
  return { match: ({ input }) => (input as Input)?.step === "triage" && (input as Input).item?.item_id === itemId && when(input as Input), output: out };
},
extract(itemId: string, out: unknown, when: (input: Input) => boolean = () => true): MockRule {
  return { match: ({ input }) => (input as Input)?.step === "extract" && (input as Input).item?.item_id === itemId && when(input as Input), output: out };
},
compose(itemId: string, out: unknown, when: (input: Input) => boolean = () => true): MockRule {
  return { match: ({ input }) => (input as Input)?.step === "compose" && (input as Input).item?.item_id === itemId && when(input as Input), output: out };
},
```

现有 `output("knowledge_processing", X)` 用例迁移：triage 用 `{ decision: "proceed", thesis, … }`；extract 用该 fixture 概念 evidence 转成的知识点；compose 用原 concepts 加上 `point_ids` 与 `dropped: []`。迁移数据写在 `test/fixtures/llm/organize_steps/<name>.json`（`{ triage, extract, compose }`），`helpers.ts` 增加 `steps(itemId, name)` 返回三条规则。

- [ ] 改 `helpers.ts`，迁移 `pipeline.test.ts` / `worker.test.ts` 现有用例到三段 replay
- [ ] 新增「测试」表 pipeline 的 5 个用例，运行确认失败
- [ ] 实现 `process.ts` 编排、`integrate.ts` evidence 字段、`pipeline.ts` 传 `indexCtx`
- [ ] 运行 `test/organize/*` 全部通过
- [ ] Commit：`feat(organize): multistep knowledge processing pipeline`

## Task 5：词条重写基于知识点

**Files**
- Modify：`services/local-ingestion/src/domains/organize/rewrite.ts`
- Test：现有重写用例所在文件（`test/organize/pipeline.test.ts` 的 `replay.rewrite` 用例与 `test/kb/kb.test.ts`）

**Consumes**：Task 1 的重写 schema；`StoredEvidence.point` / `importance`

- [ ] 写失败测试：重写输入 evidence 带 `id` / `point` / `importance`，排序 core 在前；首次输出 `covered_ids` 缺 core 证据 → 第二次调用带 `feedback` 且采用第二次结果
- [ ] 运行，确认失败
- [ ] 实现：`liveEvidence` 编号、补 `point` / `importance`（旧数据 `supporting`）、按重要度 → 可靠性排序、按 `REWRITE_EVIDENCE_TOKENS = 16_000` 截断；`rewriteEntry` 加覆盖重试（同 compose 规则）
- [ ] 运行，确认通过
- [ ] Commit：`feat(organize): point-based entry rewrite with coverage retry`

## Task 6：录制脚本、文档与全量验证

**Files**
- Modify：`scripts/record-llm-fixtures.ts`（按 `PROMPTS[name].task` 选模型；`--only` 支持新键）
- Modify：`services/local-ingestion/test/fixtures/llm/samples.ts`（由现有 knowledge_processing 样本派生 triage / extract / compose 样本与 check）
- Modify：`docs/tech-solution/07-organize.md`（流水线总览、⑤ 输入输出 / 规则 / 长文 / 成本、⑦ 词条重写，指向本文档）
- Modify：`scripts/verify/gateway-live.ts`、`scripts/verify/chat-eval.ts`、`scripts/e2e-chat.ts`、`apps/workbench/src/api/mock/*`（只在引用了已删除的 `PROMPTS.knowledge_processing` 时调整）

- [ ] 更新脚本与样本；`npm run typecheck` 通过
- [ ] 更新 07 文档
- [ ] `npm test` 全部通过
- [ ] 有真实 provider 时：`tsx scripts/record-llm-fixtures.ts --only=knowledge_triage,knowledge_extract,knowledge_compose,entry_rewrite`，检查 `recording-log.json` 无 check 失败（需 `StudyStudioData` 下的 ai-seed / secrets，无则跳过并在交付说明中注明）
- [ ] Commit：`docs(organize): multistep processing; fixtures`

## 验收

- 长文（> 10k token）所有章节都进入 S2 输入（pipeline 用例断言）。
- core / supporting 知识点要么写入词条，要么有舍弃理由；剩余遗漏可在 `organize_results.output.missing_after_retry` 查到。
- 有划线 / 笔记的条目不会在 S1 被判 duplicate。
- reject / duplicate 不调用强模型。
- `npm test`、`npm run typecheck` 通过。
