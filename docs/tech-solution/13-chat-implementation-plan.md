# 13 实施方案（对话）

目标：在已完成的「采集 → 整理 → 知识库」闭环上交付首页对话与悬浮对话。功能与技术细节以 09 为准，本文只定范围、拆分、顺序与验收。

## 范围

| 内容 | 本期 |
| --- | --- |
| 首页对话、悬浮对话、两处消息同步、清空 | 做 |
| 回顾学习记录、问学过的知识、问掌握情况、无命中说明 | 做 |
| 页面上下文提问与随页面变化的示例问题 | 做 |
| 对话发起整理（确认卡片） | 做 |
| 对话记录学习者档案（可撤销） | 做 |
| 依据列表与 `[n]` 引用跳转 | 做 |
| 不支持 tools 的模型降级 | 做 |
| 多会话 / 历史列表、对话内复习出题、学习区页面对话 | 不做 |
| 收集箱条目入箱即写检索索引 | 不做（见 09「已知限制」） |

## 现有可复用能力

| 能力 | 位置 |
| --- | --- |
| 模型网关（按任务取模型、备用模型、重试、用量） | `services/local-ingestion/src/ai/gateway.ts` |
| 混合检索 / FTS | `src/search/hybrid.ts`、`src/search/fts.ts` |
| 时间线与活动时长 | `domains/timeline/timeline.ts`、`activity.ts`、`time.ts` |
| 掌握度 | `domains/kb/mastery.ts`、`domains/kb/queries.ts` |
| 词条 / 条目详情 | `domains/kb/detail.ts`、`domains/inbox/detail.ts` |
| 手动整理 | `POST /v1/organize/run`、前端 `useOrganizeStore.openDialog` |
| 学习者档案 | `domains/data/profile.ts`、`/v1/settings/learner-profile` |
| SSE 先例 | `GET /v1/organize/events`（`streamSSE`） |
| 原型样式 | `apps/workbench/src/styles/prototype.css` 中 `.chat-*`、`.composer`、`.msg` |

## 里程碑

```text
C1 后端基础 → C2 Tools 与引用 → C3 对话接口 ─┐
            C4 前端对话界面（mock 先行，可与 C2/C3 并行）─┴→ C5 整理与档案卡片 → C6 联调与验收
```

| 里程碑 | 内容 | 预估（人日） | 状态 |
| --- | --- | --- | --- |
| C1 | 后端基础：迁移、契约、`chat` 任务、`streamChat`、mock 流式 | 1.5 | 完成 |
| C2 | Tools 与引用 | 2 | 完成 |
| C3 | 对话接口、持久化、降级路径 | 1.5 | 完成 |
| C4 | 前端对话界面（首页 + 悬浮 + 同步） | 2.5 | 完成 |
| C5 | 整理确认卡片、档案卡片、页面上下文 | 1.5 | 完成 |
| C6 | 联调、提示词调优、验收 | 1.5 | 完成（Gemini 待额度恢复后补跑） |
| 合计 | | 约 10.5 | |

### C1 后端基础

- `migrations/004_chat.sql`：`chat_messages` 表与索引（09「会话与存储」）。
- `packages/shared/src/api/chat.ts`：`ChatContext`、`ChatRequest`、数据块类型（`citations`、`organize-card`、`profile-card`）的 zod schema。
- `chat` 任务：后端 `AI_TASKS`、shared `AI_TASK_NAMES`、`seed.ts` 同步；未配置时回退「知识处理」模型；修改 `test/ai/routes.test.ts` 中「`chat` 被拒绝」的断言；设置页「按任务选择模型」显示「首页对话」。
- `AiGateway.streamChat`：主 / 备用模型（仅首 token 前切换）、用量记录、限额检查、`abortSignal`。
- mock provider 实现 `doStream`：规则回放文本与工具调用。

验收：`streamChat` 单测覆盖正常流、首 token 前失败切备用、输出中失败写入错误、超限拦截与 `allowOverLimit` 放行；`npm run check` 通过。

### C2 Tools 与引用

- `domains/chat/tools/`：`query_timeline`、`search_knowledge`、`get_entry`、`get_item`、`list_mastery`、`propose_organize`、`record_learner_profile`（09「Tools」）。
- `search_knowledge`：有 embedding 模型时 `hybridSearch`，否则 `searchFts`；按 owner 聚合，返回词条摘要与掌握度。
- `propose_organize`：`target` + context → `organizeScope` 映射纯函数。
- 引用登记表：工具结果分配 `ref`，流结束校验 `[n]` 生成 `data-citations`。
- 统一弱项阈值：`timeline.ts` 改用 `WEAK_MASTERY_THRESHOLD`。

验收：每个工具基于内存 SQLite 种子数据单测；`propose_organize` 映射覆盖 09「整理意图」表全部行；引用校验剔除不存在的序号。

### C3 对话接口与持久化

- `http/routes/chat.ts`：`GET /v1/chat/messages`、`POST /v1/chat`（`createUIMessageStream` + `streamChat` + tools，`stopWhen: stepCountIs(5)`）、`DELETE /v1/chat/messages`；在 `create-server.ts` 注册。
- 系统提示（带 `promptVersion`）：学习者档案、日期时区、页面上下文摘要、回答规则（必须引用、无命中说明、非学习记录前缀）。
- 历史截断（默认最近 20 条 + token 预算）；`onFinish` 写 assistant 消息。
- 降级路径：tools 报错识别 + 模型级内存缓存 + 规则意图识别（09「不支持 tools 的降级」）。

验收：路由测试用 mock 模型跑通四类问答（时间回顾 / 知识点 / 掌握情况 / 无命中），返回流中含依据；刷新后 `GET` 能完整回放（含卡片）；清空后为空；降级路径在 mock「不支持 tools」模式下产出相同类型的回答。

### C4 前端对话界面

- 安装 `ai`、`@ai-sdk/react`；`api` 层新增 `getChatMessages` / `clearChat`（real + mock）与 mock `ChatTransport`。
- `stores/chat.ts`：单例 `Chat` 实例，首次加载历史。
- `components/chat/`：消息列表、输入框（发送 / 停止 / 档案按钮插槽）、Markdown 消息与 `[n]` 上标、依据列表、示例问题、错误与超限确认条。
- 首页：空状态（问候、今日时长、输入框 + 档案按钮、示例问题、入口卡片）→ 有消息后消息列表；未配置模型时禁用输入并提示去配置；清空按钮。
- `ChatDock`：在 `AppLayout` 挂载，按路由决定是否显示；面板点击外部收起；生成中收起不中断。

验收：Vitest 覆盖首页空状态 / 发送 / 流式渲染 / 依据跳转、悬浮面板开合与外部点击收起、首页与悬浮消息同步、切换路由后会话保留；mock 模式可完整演示。

### C5 整理与档案卡片、页面上下文

- `useChatContext()`：从路由参数与收集箱 / 知识库已选集合派生 `ChatContext`；示例问题随页面变化。
- `OrganizeConfirmCard`：单范围确认 → `api.runOrganize`；多选项先选范围；「调整」打开整理弹窗带 `prefill`；处理 409。
- `ProfileRecordedCard`：展示记录内容，「撤销」恢复旧值。

验收：条目详情说「帮我整理该页知识点」→ 卡片范围为当前条目，确认后整理进度条出现；词条详情只说「整理」→ 出现三个选项；收集箱有已选时出现「已选」；说「我最近在学 AI 相关知识」→ 档案新增方向，撤销后恢复。

### C6 联调与验收

- 真实模型联调：Gemini、OpenRouter（tools 模式）与 Ollama `qwen2.5:7b`（tools 与降级各一次）。
- 提示词调优：用开发测试档案与现有知识库，准备 20 条问题集（四类问答各 4 条 + 整理 / 档案 / 页面提问），检查引用准确率与无命中处理，结论写回 09。
- Playwright：首页提问 → 依据跳转词条；详情页悬浮对话发起整理 → 确认 → 整理完成。

验收：问题集中引用均指向真实对象、无编造依据；无命中问题全部给出「知识库没有相关内容」；关键 Playwright 用例通过。

## 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 本地小模型 tools 调用不稳定（漏调、参数错） | 回答无依据 | 工具参数 zod 校验并把错误回给模型重试一次；降级路径兜底；对话任务允许单独选云端模型 |
| 免费云端模型 429 / 高负载 | 回答中断 | 首 token 前切备用模型；错误可一键重试 |
| 模型编造 `[n]` 或引用错位 | 依据不可信 | 服务端只认登记表中的序号；问题集抽查 |
| 长对话上下文超限 | 调用失败 | 历史按条数 + token 预算截断；工具返回正文截断 |
| 弱项阈值两处不一致 | 首页卡片与对话结论不同 | C2 统一常量 |

## 完成标准

- `npm run check`、`npm test`、关键 Playwright 用例通过。
- 09 中标为本期的功能全部可用；12 中「不做对话带来的调整」各项恢复为原设计（首页输入框与示例问题、悬浮按钮、对话识别档案、对话发起整理、AI 设置「首页对话」、`/v1/chat` 与 `chat_messages`）。
