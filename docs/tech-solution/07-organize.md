# 07 整理流水线（收集内容 → 知识库）

## 核心原则

- 学习判定（Learning Judge）判断的是「用户是否在主动形成知识」，而不是「用户是否一直盯着学习网页」。
- **一次学习 ≠ 所有内容都值得入库**：学习判定只看行为，判断「是不是学习、用户在意哪些条目」；内容是否有料、相对知识库是否新，在知识处理中结合正文与已有词条判断。
- 采集层只用实时、简单的规则（宁多勿漏）；是否学习、是否入库由整理阶段结合整条时间线判断。
- 流水线是确定性工作流（DAG），日常整理 LLM 只在 2 个节点调用：学习判定（只读行为摘要，可用小模型）、知识处理（判定 + 抽取 + 对齐 + 词条补丁，一次调用）；写库由程序完成。词条全量重写只在手动「知识点重新整理」与 `stale` 词条时调用。

## 术语

| 英文 | 中文 | 说明 |
| --- | --- | --- |
| Activity Log | 行为日志 | 活动轨迹 + 学习信号事件（见 01），不展示，只供整理使用 |
| Captured Item | 收集条目 | 收集箱中的一条（网页正文 / 问答 / 文档） |
| Activity Episode | 活动片段 | 片段切分的输出，尚未判定 |
| Learning Episode | 学习片段 | 学习判定为学习的活动片段 |
| Distraction | 分心 | 片段内与学习无关的活动 |
| Related Exploration | 关联探索 | 主题变化但存在知识关系（如 LangGraph → Checkpoint → Interrupt） |
| Return | 回归 | 分心后回到原主题 |
| Learner Profile | 学习者档案 | 角色 + 近期学习方向（见 10） |
| Content Exposure | 内容露出 | 正文各章节在可视区的累计露出时长与覆盖率（见 01、`item_exposure`） |
| Recency Weight | 时间衰减权重 | 已入库知识参考时使用 |

## 触发

| 触发 | 默认 | 处理范围 |
| --- | --- | --- |
| 手动（单条 / 已选 / 待整理 / 全量 / 知识点 / 已选知识点） | 始终可用 | 见下方范围 |
| 每天定时 | 开，23:00 | `organize_status=pending` 的条目 |
| 攒够数量 | 开，10 条 | 同上，达到 N 条即运行 |
| 入箱即整理 | 关 | 新入箱条目 |

- 「整理规则」页可关闭自动整理（总开关），关闭后只有手动整理。
- **自动整理只处理 `pending`（新增或上次失败）**；`dirty`（已整理后又编辑内容 / 新增备注）只在手动整理时处理，满足「编辑与新增备注不自动触发整理」。
- 单一任务队列串行，同一时间一批；多个触发同时命中合并为一次。
- 补跑：服务未运行错过定时，启动后补跑一次。
- 限额：达到每日 token 上限暂停，剩余条目次日继续。

## 手动整理弹窗（与原型一致）

- 范围选项：
  - 收集箱：刚才已选的（默认）/ 待整理 / 全量；
  - 知识库：已选知识点 / 待整理 / 全量；
  - 详情页：当前条目 / 当前知识点。
- 显示「本次会使用 n 条收集点/知识点/模糊备注（其中 m 条新加）」及「编辑后的内容」。
- 「整理要求」输入框 + 快捷要求 chip；填写的要求按范围保存为备注：单条 → 收集点备注；知识点 → 知识点备注；批量/全量/已选 → 模糊备注（`origin=organize_requirement`），作为本次及以后的意图信号。
- 运行中：侧栏显示进度，禁止重复发起；完成后 toast 与整理记录。

## 流水线总览

```text
[Trigger] 定时 / 攒够 N 条 / 入箱即整理 / 手动
    ↓
① Context Loader        上下文加载：待整理条目、行为日志窗口、学习者档案、备注
    ↓
② Episode Builder       片段切分（规则，不调 LLM）
    ↓
③ Learning Judge        学习判定（LLM，小模型）：这是一次学习吗？用户在意哪些条目？
    ├─ 否 → 条目 rejected（未采纳）→ ⑦
    ↓ 是（候选条目 + 条目 engagement）
    ┌───────────── 以下按条目（问答按会话线程）串行 ─────────────┐
④ Retrieve & Prefilter  已有知识检索 + 规则预过滤（本地）
    ├─ 命中规则 → duplicate / reject → ⑥
    ↓
⑤ Knowledge Processing  知识处理（多轮，见 15）
    S1 判定（小模型）→ 分块 → S2 逐块抽知识点（小模型，并行）→ 候选召回 → S3+S4 对齐与写作（强模型）→ S5 覆盖校验
    ↓
⑥ Knowledge Integration 知识入库（程序）：写库、应用补丁、派生更新 → 条目 ingested / rejected
    └──────────────────────────────────────────────────────────┘
    ↓
⑦ Organize Run          整理记录：stale 词条重写、收集箱状态、organize_runs
```

按条目串行：前一条目 ⑥ 写入后，后一条目的 ④ 能检索到刚新建 / 补充的词条，⑤ 拿到的是最新正文，补丁不会冲突。

### 路径捷径

| 场景 | 路径 | 说明 |
| --- | --- | --- |
| 自动整理 | ① → ⑦ 全流程 | — |
| 手动整理所选条目 / 当前条目（待整理） | 跳过 ②③，从 ④ 开始 | 用户已表达意图，engagement 按 `strong` 处理；仍按会话合并问答（见 ⑤） |
| 手动整理未采纳条目 | 跳过 ②③，④ 只做检索与近重复检测，⑤ 用采纳模式 | 视为用户确认入库，不提供单独「采纳」按钮；⑤ 的 `decision` 限定为 `new` / `supplement` / `duplicate`，不做价值兜底；记录 `organize_results.override=adopt`，作为后续校准判定的反馈 |
| 知识点重新整理 | 只执行词条全量重写（见 ⑦） | 用户填写的要求作为知识点备注 |

## ① 上下文加载（Context Loader）

- 以待整理条目为锚点：取这些条目 `captured_at` 所在时间段，前后各扩 `hardGapMinutes`，加载该窗口内的行为日志（`events`）与窗口内的全部收集条目。
- 只有**包含待整理条目**的活动片段才进入后续节点；纯行为片段只作为上下文，不单独判定。
- 同时加载：学习者档案（过期的学习方向不加载）、近期入库主题名（最近 30 天新增来源的词条名，最多 50 个）、三类备注与本次整理要求。

## ② 片段切分（Episode Builder）

纯规则，目标是**召回**：宁可把两次学习切在一起交给学习判定拆，也不把一次学习切碎。

### 步骤

1. **时间线片段化**：每个页面会话（`page_session`）按域名打类别。

| 类别 | 例子 | 来源 |
| --- | --- | --- |
| `learning_candidate` | 文档站、GitHub、AI 对话、搜索引擎、技术社区 | 内置列表 |
| `unrelated` | 社交、购物、娱乐视频 | 内置列表 + 用户黑名单 |
| `neutral` | 其他 | 默认 |

2. **硬切分**（任一满足即切开）：两次活动间无任何活动（含系统空闲）≥ `hardGapMinutes`；单段超过 `maxEpisodeHours` 时在内部最大间隔处切开。
3. **缝合**（任一满足即归入同一片段）：间隔 < `stitchGapMinutes`；存在跳转关系（后一页的来源页 / 打开者是前一页）；同一搜索链（从前一个搜索结果点入）；同一 AI 会话（`conversationId` 相同）。
4. **标记分心**：连续 `unrelated` 段：

| 情况 | 处理 |
| --- | --- |
| 总时长 < `shortDistractionMinutes`，之后回到 `learning_candidate` | 留在片段内，标为分心 |
| `shortDistractionMinutes` ~ `hardGapMinutes`，之后回到 `learning_candidate` | 留在片段内，标记 `long_distraction`，由学习判定决定是否拆分 |
| ≥ `hardGapMinutes` 或之后没有回来 | 切开，该段不归入前面的片段 |

切分只看域名类别，不判断回来后主题是否连续，主题连续性交给学习判定。

5. **预过滤**（不调 LLM）：

| 条件 | 处理 |
| --- | --- |
| 全部 `unrelated`，无学习信号、无收集条目 | 直接判为非学习 |
| 有效时长 < `minActiveMinutes` 且无学习信号 | 直接判为非学习 |
| 最后一次活动距今 < `openEpisodeMinutes` | 标为 `open`，推迟到下一批（自动整理）；手动整理不推迟 |

6. **生成摘要**：为每个活动片段生成学习判定的输入（见 ③）。

### 参数（可配置）

| 参数 | 默认值 |
| --- | --- |
| `hardGapMinutes` | 30 |
| `stitchGapMinutes` | 10 |
| `shortDistractionMinutes` | 15 |
| `maxEpisodeHours` | 4 |
| `minActiveMinutes` | 2 |
| `openEpisodeMinutes` | 30 |

## ③ 学习判定（Learning Judge）

每个活动片段一次 LLM 调用（任务模型：学习判定），**只传行为摘要，不传正文**。

### 输入

```json
{
  "episode_id": "ep_20261002_2000",
  "time_range": { "start": "2026-10-02T20:00:00+08:00", "end": "2026-10-02T20:40:00+08:00" },
  "active_minutes": 35,
  "learner_profile": {
    "role": "产品经理",
    "learning_focus": [{ "topic": "Agent 架构", "expires_at": "2026-11-01" }]
  },
  "recent_kb_topics": ["LangGraph", "RAG 重排"],
  "timeline": [
    { "t": "20:00", "kind": "search", "query": "LangGraph checkpoint", "engine": "google" },
    { "t": "20:02", "kind": "page", "title": "Persistence - LangGraph Docs", "domain": "langchain-ai.github.io",
      "category": "learning_candidate", "active_sec": 420, "scroll": 0.8, "captured_item_id": "item_A", "from": "search" },
    { "t": "20:10", "kind": "ai_turn", "platform": "chatgpt", "conversation_id": "c1",
      "question": "checkpoint 和 interrupt 有什么区别？", "turn_index": 1, "captured_item_id": "item_B" },
    { "t": "20:13", "kind": "ai_turn", "conversation_id": "c1", "question": "interrupt 恢复时状态从哪里读？", "turn_index": 2 },
    { "t": "20:20", "kind": "selection", "text": "interrupt() pauses graph execution..." },
    { "t": "20:25", "kind": "distraction", "domain_category": "social", "duration_sec": 300 },
    { "t": "20:30", "kind": "page", "title": "Human-in-the-loop", "category": "learning_candidate",
      "active_sec": 480, "captured_item_id": "item_C", "revisit": false },
    { "t": "20:35", "kind": "note", "text": "HITL 依赖 checkpoint 持久化" }
  ],
  "flags": ["long_distraction"]
}
```

`recent_kb_topics` 只用于辅助判断主题连续性；已入库正文的检索在 ④ 完成。

### 输出

```json
{
  "episode_id": "ep_20261002_2000",
  "is_learning": true,
  "confidence": 0.94,
  "topic": "LangGraph",
  "learning_goal": "理解 interrupt、checkpoint 与 human-in-the-loop 的关系",
  "related_exploration": ["checkpoint", "interrupt", "human-in-the-loop"],
  "distractions": [{ "start": "20:25", "duration_sec": 300, "type": "unrelated_browsing" }],
  "returned_to_topic": true,
  "signals_observed": ["active_search", "ai_multi_turn", "follow_up", "note", "return"],
  "segment_suggestion": { "action": "keep" },
  "worth_extracting": true,
  "candidate_item_ids": ["item_A", "item_B", "item_C"],
  "item_engagement": { "item_A": "medium", "item_B": "strong", "item_C": "strong" },
  "reason": "围绕 LangGraph 持久化机制主动搜索、多轮追问并记笔记，短暂分心后回到原主题"
}
```

| 字段 | 说明 |
| --- | --- |
| `segment_suggestion.action` | `keep` / `split`（附 `at`）/ `merge`（附 `with_episode_id`）。片段切分按建议修正一次后重新判定，**最多一轮** |
| `candidate_item_ids` | 进入 ④⑤ 的条目；学习片段内与主题无关的条目可排除 |
| `item_engagement` | 用户对每个候选条目的在意程度：`strong`（追问、高亮、笔记、复制）/ `medium`（回看、较长停留、高露出）/ `weak`（只有停留）。⑤ 不再重新分析行为，按此调整入库门槛 τ |
| `worth_extracting` | `false` 时（如只是查了个快递规则）不进入 ④⑤ |
| `reason` | 只存后台，不展示 |

### 判定规则（写入 prompt）

按顺序回答：

1. 有没有学习意图？（搜索、提问、追问、笔记）
2. 行为是否围绕相关的知识主题？
3. 主题变化是关联探索还是分心？
4. 分心后有没有回到原主题？
5. 这个片段值不值得进入知识处理？用户最在意哪些条目？

约束：

- 信号强弱：强信号（主动提问/追问、主动搜索、AI 多轮交互、主题语义连续、跨来源验证、实践）> 中等信号（回看、来回跳转、重复阅读、高亮、笔记、收藏）> 弱信号（停留时长、点击数、页面类型）；**弱信号不能单独决定结果**。
- 学习者档案与近期入库主题只能加分，不能作为否定依据；档案以外的主题只要行为信号够强，照样判为学习。
- 有 `long_distraction` 标记且回来后主题完全变化时，输出 `split`。

### 置信度与后续

| 判定结果 | 处理 |
| --- | --- |
| `is_learning=true` 且 `confidence ≥ 0.7` | 进入 ④ |
| `0.4 ≤ confidence < 0.7` | 进入 ④，附 `uncertain` 标记，⑤ 门槛从严 |
| `confidence < 0.4` / `is_learning=false` / `worth_extracting=false` | 片段内条目 → `rejected` |

**兜底**：带收集点备注或用户高亮的条目，在学习判定阶段不会被直接标为未采纳，至少进入 ⑤ 一次，engagement 按 `strong` 处理。

## ④ 已有知识检索与规则预过滤（Retrieve & Prefilter）

本地完成，不调 LLM。两件事：为每个候选条目找出知识库中相关的已有词条，作为 ⑤ 判断新旧、对齐与补丁的参照；用规则把明显不需要大模型的条目直接判掉。

### 查询

- **条目级（主）**：网页 = 标题 + 用户划选/高亮 + 正文前约 500 token；问答 = 问题 + 回答前约 500 token。
- **片段级（补充）**：学习判定输出的 `topic`、`learning_goal`、`related_exploration`。

### 检索

- 向量检索：词条摘要向量 + 词条正文块向量（`chunks_vec`，`owner_type=entry`）。
- 精确匹配：FTS 按词条名称 / 别名匹配 `related_exploration`。
- 两路结果合并去重，每个条目取 top-5，`similarity < 0.55` 丢弃。

### 打分

```text
similarity        = 语义相似度（原始值，不衰减）
recency_weight    = max(0.5 ^ (Δdays / halfLife), floor)    Δdays = 词条最近一次新增来源距今天数
recency_relevance = similarity × recency_weight
```

默认 `halfLife = 21` 天，`floor = 0.3`。

- **判断重复用 `similarity`**：旧知识的重复仍是重复，用衰减分会漏判。
- **加分用 `recency_relevance`**：与最近在学的知识越相关越容易入库。
- `floor` 防止旧知识完全失去参考作用。

### 输出

```json
{
  "item_id": "item_C",
  "related_entries": [
    {
      "entry_id": "kb_hitl",
      "name": "Human-in-the-loop",
      "summary": "在图执行中插入人工审批节点……",
      "similarity": 0.86,
      "recency_weight": 0.81,
      "recency_relevance": 0.70,
      "last_source_at": "2026-09-26",
      "mastery": 0.42
    }
  ],
  "ignored_matches": []
}
```

- `ignored_matches`：命中 `kb_ignore` 的名称，⑤ 不得对齐或新建这些词条。
- 冷启动：知识库为空时 `related_entries` 为空，流程照常。

### 规则预过滤

| 规则 | 结果 | 进入 ⑤ |
| --- | --- | --- |
| 条目标题 / 主题命中 `kb_ignore` | `reject`（`ignored`） | 否 |
| 正文 hash 或 SimHash 与已入库来源近乎相同（同一内容再次收集） | `duplicate`，挂到原来源所属词条 | 否 |
| 最高 `similarity ≥ 0.93` 且条目无备注 / 高亮 | `duplicate`，挂到该词条 | 否 |
| 正文过短、链接密度高、列表页特征（与采集层列表页规则同源） | `reject`（`navigational` / `low_information`） | 否 |
| 其余 | — | 是 |

- 兜底：带备注或高亮的条目不会被规则判 `reject`，至少进入 ⑤ 一次。
- 规则判定的 `duplicate` 同样计入「已入库」与词条来源数；evidence 取条目标题与高亮（无高亮取正文首段）。
- 规则命中写 `organize_results.route=prefilter` 与命中的规则名，用于抽样校准阈值。

## ⑤ 知识处理（Knowledge Processing）

每个候选条目多轮调用，详见 [15 整理多轮处理](./15-organize-multistep.md)：

1. **S1 判定**（小模型）：大纲 + 节选 → `proceed` / `duplicate` / `reject` + 核心论点；有划线 / 笔记的条目不在 S1 判 `duplicate`；`reject` / `duplicate` 到此结束。
2. **分块 + S2 抽取**（小模型，并发 3）：文档按标题 / 段落切块（约 6k token），问答按整轮切块；每块输出带 `importance`（core / supporting / detail）的知识点与逐字引文。
3. **S3+S4 对齐与写作**（强模型）：按概念召回候选词条，把知识点分配到已有 / 新词条并写补丁 / 正文，舍弃的知识点必须给理由。
4. **S5 覆盖校验**：结构问题重试一次（仍失败 → `failed`）；core / supporting 遗漏重试一次，保留更好的结果，剩余遗漏记入 `organize_results.output.missing_after_retry`。

程序把多轮结果组装为下文的单一输出结构，⑥ 不变。问答按会话线程组装（见「问答的处理」）。下面的输入 / 输出描述的是组装后的整体语义。

### 输入

```json
{
  "episode": {
    "episode_id": "ep_20261002_2000",
    "topic": "LangGraph",
    "learning_goal": "理解 interrupt、checkpoint 与 human-in-the-loop 的关系",
    "uncertain": false
  },
  "learner_profile": { "role": "产品经理", "learning_focus": ["Agent 架构"] },
  "item": {
    "item_id": "item_C",
    "type": "webpage",
    "source_kind": "official_doc",
    "title": "Human-in-the-loop - LangGraph Docs",
    "content": "……正文，章节标注露出权重（高 / 低 / 未露出）……",
    "user_highlights": ["interrupt() pauses graph execution..."],
    "user_note": "HITL 依赖 checkpoint 持久化",
    "fuzzy_notes": ["……语义匹配的模糊备注……"],
    "requirement": "……本次整理要求（如有）……",
    "engagement": "strong"
  },
  "related_entries": [
    {
      "entry_id": "kb_hitl", "name": "Human-in-the-loop", "aliases": ["HITL"], "kind": "概念",
      "summary": "在图执行中插入人工审批节点……",
      "similarity": 0.86, "recency_relevance": 0.70,
      "outline": ["## 定义", "## 实现方式", "## 常见场景"],
      "body_markdown": "……仅相似度最高的 2 个词条附正文……"
    }
  ],
  "neighbor_entries": [{ "entry_id": "kb_checkpoint", "name": "Checkpoint", "aliases": [] }],
  "categories": ["Agent 框架", "RAG"],
  "kinds": ["概念", "方法", "算法", "模型", "论文", "工具", "库与框架", "设计模式", "最佳实践", "其他"]
}
```

- `content`：用户编辑版优先，清洗后传入；章节按 `item_exposure` 标注权重。
- 意图信号：收集点备注（高权重）+ 语义匹配的模糊备注（向量 Top-3 且时间 ±1 天）+ 本次整理要求。
- `engagement`：来自 ③ 的 `item_engagement`，⑤ 不再接收原始行为数据。
- `related_entries`：来自 ④，最多 5 个；相似度最高的 2 个附 `body_markdown`（补丁需要看到原文），其余只给摘要与大纲。
- `neighbor_entries`：`related_entries` 的一跳关联词条（名称与别名），扩大对齐候选，不附正文。
- `categories`：已有分类名，供新词条选择分类。
- `kinds`：类型词表（种子类型 + 已用类型）。新词条 `kind` 优先从中选择，都不合适时给新类型名（2–6 字中文名词，表示性质而非主题）；程序端 `resolveKind` 归一化去重，英文旧代码映射为中文，类型总数达 20 或名称超 8 字时落为「其他」（见 14 A3/A4）。
- `source_kind`：`official_doc` / `repo` / `community` / `blog` / `ai_answer` / `other`，由 `items.type` + 域名规则推导。
- 预算：单次输入约 16k token（正文 ≤ 10k，词条参照 ≤ 5k）；超出走「长文」路径。

### 输出

按 `decision` 区分的结构（Zod discriminated union）：

```json
{
  "item_id": "item_C",
  "decision": "supplement",
  "value_score": 0.74,
  "reason": "已有 HITL 词条，但缺少与 checkpoint 的关系",
  "item_summary": "……",
  "item_points": ["……"],
  "concepts": [
    {
      "name": "Human-in-the-loop", "match": "kb_hitl",
      "evidence": [{ "quote": "……" }],
      "patch": {
        "ops": [
          { "op": "append_to_section", "section": "## 实现方式", "markdown": "……" },
          { "op": "add_section", "after": "## 实现方式", "heading": "## 依赖 checkpoint 持久化", "markdown": "……" }
        ],
        "summary": null,
        "completeness": { "covered": ["定义", "实现方式"], "missing": ["性能影响"] }
      }
    },
    {
      "name": "interrupt()", "aliases": ["interrupt"], "kind": "方法", "match": "new",
      "category": "Agent 框架",
      "summary": "……", "body_markdown": "……",
      "completeness": { "covered": ["用法"], "missing": ["恢复语义"] },
      "evidence": [{ "quote": "……" }]
    }
  ],
  "relations": [
    { "from": "interrupt()", "to": "Human-in-the-loop", "type": "part_of" },
    { "from": "Checkpoint", "to": "interrupt()", "type": "contrasts", "description": "checkpoint 负责持久化状态，interrupt 负责暂停执行等待输入" }
  ]
}
```

`reject` 只输出 `{ item_id, decision, value_score, reject_reason, reason }`；`duplicate` 只输出 `{ item_id, decision, value_score, target_entry_ids, evidence_by_entry, reason }`。两者输出很短，成本主要在输入。

| 字段 | 说明 |
| --- | --- |
| `item_summary` / `item_points` | 条目摘要与要点，写 `organize_results` |
| `concepts[].match` | 已有词条 `entry_id`（必须来自 `related_entries` / `neighbor_entries`）或 `"new"` |
| `patch` | 只用于已有词条；`ops` 限 `append_to_section` / `add_section` / `replace_section`（仅修正冲突或错误，须在 `reason` 说明）；`summary` 有变化时才输出 |
| 新词条 | 直接输出初版 `summary`、`body_markdown`、`completeness` |
| `relations` | `type`：`part_of` / `prerequisite` / `related` / `contrasts`；`contrasts` 必填 `description`（一句话区别），供两端词条渲染「与 X 的区别」 |

| decision | 含义 | 后续（⑥） | 收集箱状态 |
| --- | --- | --- | --- |
| `new` | 知识库中还没有的知识 | 新建词条（可同时补丁已有词条） | 已入库 |
| `supplement` | 给已有词条补充新要点 | 应用补丁（可同时新建子概念） | 已入库 |
| `duplicate` | 已被已有词条覆盖 | 只挂来源与 evidence（计入掌握度的来源数） | 已入库 |
| `reject` | 无入库价值 | 结束 | 未采纳 |

`reject_reason`：`off_topic` / `low_information` / `navigational` / `transient`（一次性信息，如某个报错的临时解法、某个配置值）/ `ignored`（命中 `kb_ignore`）。

### 规则（写入 prompt）

- **价值**：解释原理、区别、原因、方法的内容价值高；`engagement=strong` 的内容价值更高；有笔记时必须参考笔记，笔记说明了用户认为哪部分重要。`recency_relevance` 高时适当放宽 `new` / `supplement`；学习者档案只能加分，不能作为 `reject` 理由。
- **新旧**：能列出至少一条目标词条正文 / 摘要中没有的要点 → `supplement`，补丁只写增量；列不出 → `duplicate`。
- **抽取范围**：高露出章节与高亮 / 笔记相关部分优先；未露出章节降权但不排除（可能下次再读；短页面一屏可见时各章节露出接近）；长文只抽有价值的部分。
- **对齐**：概念与候选词条同义（含中英文、缩写、别名）时必须使用已有 `entry_id`，不得新建同义词条；对比类内容不新建「对比」词条，输出 `contrasts` 关系。
- **补丁**：保持原有结构与语气，不重复已有内容；与原文冲突时以 `official_doc` / `repo` 为准，`ai_answer` 来源不得覆盖文档来源的内容。
- 不输出「与 X 的区别」「常见疑问」段落（由程序渲染，见 ⑥）。

### 代码侧兜底

| 条件 | 阈值 τ |
| --- | --- |
| `engagement=strong` | 0.4 |
| `engagement=medium` | 0.5 |
| `engagement=weak` | 0.6 |
| 片段标记 `uncertain` | 上述 +0.2 |

- `decision ∈ {new, supplement}` 但 `value_score < τ` → 改判 `reject`（`low_information`），抽取结果不写库，原始输出保留在 `organize_results.output` 供校准。
- 采纳模式（手动整理未采纳条目）不做此兜底。
- 结构校验失败：按 06 的「本地校验 + 一次修复重试」，仍失败 → `failed`。

### 长文

长短内容同一路径：S1 只看大纲 + 节选（高亮附近 → 高露出章节 → 正文前段，约 3k token），S2 按分块覆盖全文所有章节，不再只取重点章节。

### 问答的处理

收集箱按轮存储问答（每轮一个 `conversation` 条目），整理时按会话处理：

1. **按会话线程组装**：同一 `conversationId` 在同一学习片段内的连续多轮合并为一个线程输入，保留追问上下文（如第 2 轮「它恢复时状态从哪里读？」中的「它」）；evidence 仍精确指向具体某一轮的 `item_id`。
2. **evidence 包含问题**：问答来源的 evidence 记录 `{ question, quote, turn_item_id }`，问题本身代表用户的疑惑点，供程序渲染「常见疑问」。
3. **对比类问题**（「A 和 B 有什么区别」）：不新建「对比」词条，抽取为 `contrasts` 关系边（带 `description`），边来源指向该轮问答；A、B 两个词条都由程序渲染「与 X 的区别」段落。
4. **来源可靠性**：`source_kind=ai_answer` 的 evidence 可靠性低于 `official_doc` / `repo`；冲突时以文档为准。

## ⑥ 知识入库（Knowledge Integration）

程序完成，不调 LLM；每个条目一个事务。

```text
对齐校验
  match 为已有 entry_id：校验存在且未删除，否则按 "new" 处理
  match = "new"：名称 / 别名归一化（大小写、全半角、中英括号）精确命中已有词条 → 改为该词条
                 未命中：名称 embedding 相似度 > 0.92 且 kind 相同 → 改为该词条，名称记为别名
                 改为已有词条时，新词条正文降级为 add_section「补充」追加
                 否则新建
  kb_ignore 中的名称直接丢弃
写入（单事务）
  新词条：kb_entries（summary、body_markdown、completeness）；分类：已有分类优先，否则新建
  已有词条：应用 patch.ops 到 body_markdown；有 summary / completeness 时覆盖；patch_count + 1
  涉及词条：追加 kb_entry_sources(evidence, source_kind)
  relations：kb_edges + kb_edge_sources（contrasts 带 description）
  duplicate：只追加 kb_entry_sources(evidence)
  条目：organize_results、organize_status、dirty=0、备注 used_at
同步派生：新建 / 修改词条的摘要向量（下一条目的 ④ 需要检索到）
异步派生：正文 chunks / FTS / 正文块向量；掌握度自动估算（见 08）
```

### 补丁应用

| op | 应用方式 |
| --- | --- |
| `append_to_section` | 追加到该标题所属章节末尾 |
| `add_section` | 在 `after` 章节之后插入新章节 |
| `replace_section` | 替换该章节内容；原章节内容存入 `organize_results.output` 便于回滚 |

- 标题按文本归一化后匹配；找不到 → 降级为在文末 `add_section`。
- `user_edited` 词条：不改正文与摘要，补丁渲染为 Markdown 追加到「整理建议」段（累积，用户编辑保存后清空）；来源照常追加。

### 程序渲染段落

词条详情读取时由程序生成，不存入 `body_markdown`，也不受 `user_edited` 影响：

- 「与 X 的区别」：该词条的 `contrasts` 边 + `description` + 边来源链接。
- 「常见疑问」：问答来源 evidence 中的 `question`，链接到对应那一轮问答。

## ⑦ 整理记录（Organize Run）

### 词条全量重写（Entry Rewrite）

任务模型：词条重写（中档模型即可，基于给定素材改写归纳）。

| 触发 | 范围 |
| --- | --- |
| 手动「知识点重新整理」 | 所选词条 |
| `stale` 词条（来源被删除） | 本批结束时，对 `stale=1` 的词条重写并清除 `stale` |
| 全量整理 | 全部词条 |

```text
输入：该词条所有来源的 evidence（带 id、point、importance；按 importance → source_kind 可靠性排序，截断到约 16k token）+ 知识点备注 + 现有正文 + 关联词条名
输出：body_markdown、summary、completeness{ covered[], missing[] }、covered_ids、dropped[{id, reason}]；重写后 patch_count 归零
覆盖校验：core / supporting 证据既未 covered 也未 dropped → 带反馈重试一次，保留遗漏更少的结果
user_edited 词条：不覆盖正文，只追加「整理建议」段
```

补丁累积会使正文结构变散：`patch_count ≥ 8` 时知识库详情显示「建议重新整理」提示，不自动重写。

### 收集箱状态

| `organize_status` | 中文 | 来源 |
| --- | --- | --- |
| `pending` | 待整理 | 新入箱 / 片段 `open` 推迟 |
| `ingested` | 已入库 | ④ 规则或 ⑤ 判定 `new` / `supplement` / `duplicate` 且写入成功；或对未采纳条目手动整理 |
| `rejected` | 未采纳 | ③ 判定非学习，或 ④ 规则 / ⑤ 判定 `reject` |
| `failed` | 整理失败 | 节点异常，展示为待整理 |

`dirty` 维持独立字段，含义不变。

### 记录

- 写 `organize_runs`：触发方式、片段数（学习 / 非学习 / 推迟）、条目入库 / 未采纳 / 失败数及原因、预过滤命中数、知识库变化（+n 知识点、+m 关系、补充 k 个词条、重写 j 个词条）、各阶段调用与 tokens、模型。
- 判定理由（`reason`、`reject_reason`）只存后台（`organize_results`、`episodes`），用于调试与后续校准，收集箱不展示。

## 增量、失败与成本

- 增量：`input_hash = hash(正文 + 使用的备注 + 所属片段的判定结果 + prompt_version)`，未变化跳过。
- 失败：单条失败记录原因跳过，不阻塞整批（每个条目独立事务，已写入的条目不回滚）；「重试失败项」重新入队。
- 全量：重跑所有条目并全量重写全部词条正文；`user_edited` 只补充不覆盖。
- 成本控制：
  - ③ 只传行为摘要，可用小模型；
  - ④ 规则预过滤，近重复、导航页、`kb_ignore` 不调 LLM；
  - ⑤ S1 / S2 用小模型，`reject` / `duplicate` 不调用强模型；只有 S3+S4 用强模型，候选词条正文合计 ≤ 12k token；
  - 词条全量重写只在手动、`stale`、全量整理时发生。

## 选型

### S12 知识抽取方案

| 方案 | 语言 | 优点 | 缺点 |
| --- | --- | --- | --- |
| ★ 自研 TS 流水线（参考 LightRAG 的「抽取 → 按名称合并 → 描述摘要」思路） | TS | 与现有服务同栈；能满足本项目特有需求：来源/evidence 级联删除、`user_edited` 不覆盖、三类备注意图信号、wiki 正文与完整度、分类目录 | 需自行调提示词与对齐策略 |
| LightRAG | Python | 增量插入、图 + 向量双检索，成本比 GraphRAG 低 | 需引入 Python 运行时；数据模型固定，难以支持来源回滚与用户编辑保护 |
| Microsoft GraphRAG | Python | 社区摘要、全局问答强 | 建索引 token 成本高，增量更新弱，个人场景过重 |
| Graphiti（Zep） | Python | 时序知识图谱、增量 | 依赖 Neo4j/FalkorDB，部署成本高 |
| LlamaIndex.TS PropertyGraph | TS | 同栈 | TS 版图谱能力弱于 Python 版，定制仍需大量代码 |

### S13 任务队列与定时

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ SQLite `organize_jobs` 表 + 单 worker 循环 + croner 定时 | 持久化、重启可恢复、无额外依赖（croner 零依赖、支持时区）；补跑逻辑自己控制 | 队列逻辑自写（约 200 行） |
| p-queue | 简单并发控制 | 纯内存，重启丢任务 |
| BullMQ | 功能全 | 需要 Redis，不适合本地单机分发 |
| plainjob / liteque 等 SQLite 队列库 | 现成持久化队列 | 社区小、维护不确定；需与 `node:sqlite` 适配 |
