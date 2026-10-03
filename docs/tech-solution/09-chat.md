# 09 首页对话与悬浮对话

实施拆分与验收见 `13-chat-implementation-plan.md`。

## 功能

### 入口

- **首页对话**：问候 + 今日学习时长、输入框（右侧圆形按钮打开学习者档案弹窗）、示例问题、入口卡片（今日学习、知识库、薄弱知识点）。未配置对话模型时输入框禁用并提示去配置。有消息后切换为消息列表 + 底部输入框。
- **悬浮对话**：知识库、词条详情、学习进度、收集箱、条目详情、整理记录页右下角圆形 icon 按钮（首页与设置页不显示）；展开为右下角面板，点击面板外区域收起，收起不打断正在生成的回答。
- **首页与悬浮对话共用同一会话**，消息实时同步。

### 用户能做什么

| 能力 | 示例 | 数据来源 | 回答内容 |
| --- | --- | --- | --- |
| 回顾学习记录 | 我今天学了什么 / 最近一周学了哪些 | 时间线、学习会话、阅读时长 | 时长、会话主题、涉及知识点、建议继续的内容 |
| 问学过的知识 | RAG 到底是什么 | 知识库词条、关联词条、来源摘录 | 定义与要点、组成部分及各自掌握程度、未覆盖的部分、建议先补的知识点 |
| 问掌握情况 | 我哪些知识掌握得不好 | 掌握度 | 薄弱 / 熟悉列表与学习路径建议 |
| 问没学过的内容 | 什么是 k8s | 无命中 | 说明「知识库没有相关内容」；可用通用知识回答，标注「非学习记录」 |
| 针对当前页面提问 | 这篇文章讲了什么 / 这个知识点讲解是否完整 | 当前条目 / 词条全文 | 基于当前对象回答 |
| 发起整理 | 帮我整理该页知识点 / 整理 | 页面上下文 | 返回「整理确认卡片」，用户确认后执行 |
| 记录学习者档案 | 我是产品经理 / 我最近在学 AI 相关知识 | — | 写入档案，回复「好的，已记录」并可撤销 |

- 回答必须基于学习记录与知识库，正文用 `[n]` 标注，底部列出依据（词条、条目、学习日），点击跳转。
- 对话不计入收集箱与学习时长（扩展已排除工作台同源页面）；可清空。
- 示例问题随页面变化：首页「我今天学了什么」「我哪些知识掌握得不好」；条目详情「这篇文章讲了什么」「帮我整理该页知识点」；词条详情「这个知识点讲解是否完整」「它和哪些知识点有关」；收集箱「帮我整理已选内容」。

### 整理意图

| 输入 | 所在页面 | 行为 |
| --- | --- | --- |
| 「帮我整理该页知识点」 | 条目详情 / 词条详情 | 自动识别当前对象，卡片预填范围 `item` / `entry` 与整理要求 |
| 「整理」（无明确范围） | 词条详情 | 卡片给出选项：当前知识点 / 所有未整理内容 / 全量 |
| 「整理」 | 收集箱 / 知识库 | 卡片给出选项：待整理 / 全量 / 已选（有已选时） |
| 「整理」 | 其他页面 | 卡片给出选项：待整理 / 全量 |

任何整理都需用户在卡片中确认，模型不能直接执行整理。学习者档案属于用户主动陈述，允许直接写入，但卡片上提供「撤销」。

## 会话与存储

- 单一会话：`session_id = "main"`，首页与悬浮对话共用；「清空」删除该会话全部消息。多会话 / 历史列表本期不做。
- 迁移 `004_chat.sql`：

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,          -- UIMessage.id
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- user | assistant
  parts TEXT NOT NULL,          -- UIMessage.parts JSON（文本、工具调用结果、data-citations、data-organize-card 等）
  context TEXT,                 -- 发送时的页面上下文 JSON（仅 user）
  model TEXT,                   -- providerId/model（仅 assistant）
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

- 持久化格式直接用 AI SDK `UIMessage`，加载即可回放（含卡片与依据）。备份清单已包含 `chat_messages`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/chat/messages` | 返回会话全部 `UIMessage[]`（倒序取最近 200 条） |
| `POST` | `/v1/chat` | `{ message: UIMessage, context, allowOverLimit? }`，返回 UI message stream（SSE） |
| `DELETE` | `/v1/chat/messages` | 清空会话 |

- 前端只发送最后一条用户消息，历史由服务端从库中读取（`prepareSendMessagesRequest`）。
- 页面上下文（`packages/shared/src/api/chat.ts`）：

```ts
type ChatContext = {
  page: "home" | "wiki" | "entry" | "progress" | "inbox" | "item" | "runs";
  entryId?: string;
  itemId?: string;
  selectedItemIds?: string[];   // 收集箱已选
  selectedEntryIds?: string[];  // 知识库已选
};
```

## 服务端流程

```text
POST /v1/chat
  1. 校验 body（zod）、写入 user 消息
  2. 加载最近 N 轮历史（按 token 预算截断，默认 20 条）→ convertToModelMessages
  3. 组装系统提示：学习者档案、当前日期与时区、页面上下文摘要（当前词条 / 条目标题）、回答规则
  4. gateway.streamChat({ task: "chat", system, messages, tools, stopWhen: stepCountIs(5) })
  5. createUIMessageStream 合并：模型文本 / 工具调用 + 自定义数据块（data-citations、data-organize-card、data-profile-card）
  6. onFinish：校验引用、写入 assistant 消息（parts + model）、记录用量
```

### 网关扩展（06）

- `AI_TASKS` 与 shared `AI_TASK_NAMES` 新增 `chat`；AI 设置「按任务选择模型」显示「首页对话」。未单独配置时回退到「知识处理」的模型；两者都没有时首页提示去配置。
- `AiGateway.streamChat(params)`：按任务取主模型 + 备用模型；**只在首个 token 之前**失败才切备用模型，开始输出后失败直接把错误写入流；`onFinish` 记录用量；超出每日上限时返回 `usage_limit_exceeded`，前端提示后带 `allowOverLimit: true` 重发（06 已约定「对话提示超限并允许本次继续」）。
- mock provider 补 `doStream`：按规则回放文本与工具调用，供测试与前端离线演示。

### Tools

| 工具 | 输入 | 实现（复用） | 返回 |
| --- | --- | --- | --- |
| `query_timeline` | `from`, `to`（YYYY-MM-DD） | `getTimeline` + `collectActivities` | 每日时长、学习会话（标题、站点、时长、itemId） |
| `search_knowledge` | `query`, `k`（≤ 8） | `hybridSearch`（无 embedding 模型时只走 `searchFts`），按 owner 聚合 | 词条（名称、摘要、掌握度、命中片段）、条目片段 |
| `get_entry` | `id` | `getKbEntryDetail` | 词条正文（截断到 6k 字）、关联词条、来源 |
| `get_item` | `id` | `getItemDetail` | 条目标题、来源、正文（截断到 6k 字）、问答内容 |
| `list_mastery` | `level: weak \| familiar` | `loadAliveEntries` + `effectiveMastery` | 词条列表（名称、掌握度、分类） |
| `propose_organize` | `target: current \| pending \| all \| selected \| ask`, `requirement?` | 结合 context 映射到 07 的 `organizeScope` | 只生成 `data-organize-card`，不执行 |
| `record_learner_profile` | `role?`, `direction?` | `readLearnerProfile` / `saveLearnerProfile`（方向默认有效期 30 天） | 写入并生成 `data-profile-card`（含撤销所需的旧值） |

- `propose_organize` 的映射：`current` 在条目详情 → `item`，在词条详情 → `entry`；`pending` 在收集箱 / 其他页 → `inbox_pending`，在知识库 → `kb_pending`；`all` → `inbox_all` / `kb_all`；`selected` → `inbox_selected` / `kb_selected`（无已选时退化为 `ask`）；`ask` 时卡片按上文「整理意图」表列出选项。
- 掌握度弱项阈值统一用 `domains/kb/mastery.ts` 的 `WEAK_MASTERY_THRESHOLD`（0.4），同时把 `timeline.ts` 中 0.3 的写法改为引用该常量。
- 当前词条 / 条目在系统提示里只给标题与 id，正文由模型按需调用 `get_entry` / `get_item`，避免每轮都塞全文。

### 引用

- 每次请求内维护引用登记表：工具结果中的每个对象（词条、条目、学习日）分配序号 `n` 并随结果返回 `ref: n`；系统提示要求用 `[n]` 标注。
- 流结束时扫描正文中的 `[n]`，只保留登记表中存在的序号，生成 `data-citations`：`[{ n, kind: "entry" | "item" | "day", id, title }]`。正文中无效的 `[n]` 前端按纯文本显示。
- 没有调用任何检索工具、也没有引用的回答，系统提示要求以「以下内容非学习记录」开头；前端对该回答加「非学习记录」标记。

### 不支持 tools 的降级

- 模型调用因 tools 不被支持而报错（400 且错误信息含 tool / function）时，按模型记入内存缓存，本次及之后改走降级路径。
- 降级路径：规则意图识别 → 固定检索 → 单轮 `streamText`：
  - 时间词（今天 / 昨天 / 本周 / 最近 N 天 / 日期）→ `query_timeline`；
  - 「整理」关键词 → 直接产出 `propose_organize` 卡片，不调模型；
  - 「我是 / 我最近在学」→ `record_learner_profile`；
  - 「掌握 / 薄弱」→ `list_mastery`；
  - 其他 → `search_knowledge` + 当前页面对象全文。

### 联调与调优结论（C6）

问题集与脚本：`npm run verify:chat [-- --model=provider/model --only=1,2]`，在数据库快照上跑 20 条问题（时间回顾、知识点、掌握情况、无命中各 4 条，加整理 / 档案 / 页面提问），报告写到 `tmp/chat-eval-<模型>.json`。

| 模型 | 结果 | 说明 |
| --- | --- | --- |
| OpenRouter `nemotron-3-super-120b-a12b:free` | 16/20 | 失败都是回答点名词条但没写 `[n]`，已用「点名兜底」修复 |
| Ollama `qwen2.5:7b`（本机 CPU） | 13/20 | 漏引用的 #6、#7 修复后重跑通过；另 4 条是 5 分钟内没返回首个 token 而超时；单条耗时 40s–9min，不适合日常对话 |
| Gemini `gemini-3.8-flash` | 未完成 | 免费额度 20 次/天，当天已用完 |

调优后的做法：

- **预检索**：调用模型前先按规则跑只读工具（时间词、掌握度、知识搜索、当前页面对象），结果以「已检索资料」写进系统提示。小模型经常不调工具、还会编造「根据知识库检索结果」，预检索后即使不调工具也有真实依据。
- **直达意图**：短的「整理」指令和「我是 / 我最近在学」陈述直接执行工具并返回固定文本，不调模型。之前模型会声称「已显示卡片」但没有调用工具。
- **历史只传文本**：之前轮次只把纯文本（去掉 `[n]`）给模型，避免旧序号与本轮登记表冲突。
- **引用兜底顺序**：先解析正文 `[n]`（兼容 `【n】`、`[1, 2]`、`【1†ref1】`）；没有时用本轮 `get_entry` / `get_item` / `query_timeline` / `list_mastery` 取到的对象（最多 8 个）；再没有时用正文中原样出现名称的搜索命中词条。
- **非学习记录**：没有引用，且满足「没有登记任何对象」或「正文含『以下内容非学习记录』」或「以『知识库没有相关内容。』开头」之一时，才标记为非学习记录。
- **搜索**：整句提问改为按词 OR 匹配（去停用词），整句 AND 匹配几乎无命中。
- **限额冷却**：429 且提示等待超过 60 秒（如 Gemini「retry in 8h」）时不重试，并在提示时间内跳过该模型、直接走备用模型。

建议：对话任务优先选云端模型；本机 7B 模型只作备用。

## 前端

- 依赖：`ai`、`@ai-sdk/react`（v4，支持 React 19）。
- 会话共享：`stores/chat.ts` 创建单例 `Chat` 实例（`DefaultChatTransport`，`api: "/v1/chat"`），首页与悬浮面板都用 `useChat({ chat })`，消息天然同步；首次挂载从 `GET /v1/chat/messages` 填充。
- 页面上下文：`useChatContext()` 从当前路由参数与已选集合（收集箱 / 知识库 store）派生，发送时由 transport 附带。
- 组件（`components/chat/`）：`ChatMessageList`、`ChatComposer`（输入、发送 / 停止、档案按钮插槽）、`ChatMessage`（react-markdown 渲染，`[n]` 渲染为可点击上标）、`CitationList`、`OrganizeConfirmCard`、`ProfileRecordedCard`、`ExampleQuestions`、`ChatDock`（悬浮按钮 + 面板，点击外部收起）。
- 整理卡片：单一范围时显示范围、目标名称、整理要求（可编辑），「确认整理」调用 `api.runOrganize`，进度沿用现有整理进度条与 toast；多选项时先选范围；「调整」打开现有整理弹窗（`useOrganizeStore.openDialog`，带 `prefill`）。409 `run_in_progress` 时提示「已有整理在进行」。
- 档案卡片：显示记录的角色 / 方向，「撤销」用卡片中的旧值调用 `PUT /v1/settings/learner-profile`。
- 错误与状态：生成中显示停止按钮；网络 / 模型错误在消息下方显示并可重试；超限显示确认条，确认后带 `allowOverLimit` 重发。
- mock 模式：实现 mock `ChatTransport`，按关键词返回预置流（含依据与两种卡片），供开发与 Vitest 使用。

## 选型

### S17 对话 UI 与流式协议

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ AI SDK UI `useChat` + 自研界面 | 与后端 `streamText` 协议原生配套（流式、tools 结果、自定义数据块如确认卡片）；UI 完全按原型绘制；共享 `Chat` 实例天然支持首页与悬浮同步 | 消息持久化与加载需自己接 |
| assistant-ui | 现成聊天组件（流式、Markdown、工具 UI），可接 AI SDK | 视觉与原型差异需覆盖样式；多一层抽象 |
| 全自研 SSE 协议与 UI | 无依赖 | tools 调用、流式中断、重连都需自写 |

### 检索融合

沿用整理阶段已实现的 `hybridSearch`（两路取最大分、双路命中加分），不再单独实现 RRF；检索相关能力（FTS5、sqlite-vec、Embedding 模型）见 02、06。

## 已知限制

- 收集箱条目正文只有「重建索引」时才写入 `chunks`，整理流程只索引词条；对话检索以词条为主，条目通过词条来源与 `get_item` 触达。需要直接检索未整理条目时，再在入箱时增量索引条目正文。
- 学习区（05）未上线，悬浮对话不含学习区页面。
