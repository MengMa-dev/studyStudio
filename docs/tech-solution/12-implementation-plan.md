# 12 实施方案（本期开发）

本期目标：打通「采集 → 存储 → 整理 → 知识库」闭环，并交付对应的工作台页面。技术细节以 01–11 为准，本文只定范围、拆分、顺序与验收。

## 范围

| 模块 | 依据 | 本期 |
| --- | --- | --- |
| 采集与扩展离线同步 | 01 | 做 |
| 本地服务与 SQLite 存储 | 02 | 做 |
| 收集箱、备注、删除与回收站 | 03 | 做 |
| 学习进度与时间线 | 04 | 做 |
| AI 配置与模型网关 | 06 | 做（不含对话任务） |
| 整理流水线 | 07 | 做 |
| 知识库（目录 + 词条） | 08 | 做（不含图谱） |
| 设置、数据与隐私 | 10 | 做 |
| 前端工程、扩展工程、交付 | 11 | 做 |
| 首页对话与悬浮对话 | 09 | **不做** |
| 学习区、知识图谱 | 05、08 | 不做（沿用 00 的约定） |

### 不做对话带来的调整

| 原设计 | 本期处理 |
| --- | --- |
| 首页（问候 + 对话输入框 + 示例问题 + 入口卡片） | 首页保留问候、今日学习时长、入口卡片（今日学习 / 知识库 / 薄弱知识点）与学习者档案按钮；去掉输入框与示例问题 |
| 悬浮对话按钮 | 不显示 |
| 对话中识别学习者档案（「我是产品经理」） | 不做；档案只在设置与首页按钮弹窗中编辑 |
| 对话发起整理（整理确认卡片） | 不做；整理只通过按钮与整理弹窗 |
| AI 设置「按任务选择模型」中的「首页对话」 | 不显示 |
| `/v1/chat`、`chat_messages` 表、对话用混合检索（RRF） | 不建；整理 ④ 用到的向量 + FTS 检索照做，后续对话直接复用 |

## 仓库与工程

按 11 的目标结构落地，全仓库使用 TypeScript（现有 JS 代码迁移为 TS），使用 npm workspaces：

```text
apps/workbench            React SPA（新建）
apps/browser-extension    WXT 工程（迁移）
apps/desktop              暂缓，保留注入包，不改动
packages/collector-contract   事件类型与校验（扩充行为事件）
packages/collector-runtime    采集运行时（扩充行为记录、内容露出）
packages/shared               API 类型与 Zod schema（前后端、扩展共用）
services/local-ingestion      本地服务（Hono + node:sqlite）
  src/ http/ db/ migrations/ domains/{capture,inbox,notes,timeline,organize,kb,settings,data}/ ai/ jobs/
```

- 服务端开发用 `tsx` 运行，发布用 tsup 打包；前端 Vite；扩展 WXT。
- 测试：服务与流水线 `node:test`（内存 SQLite）；前端 Vitest + Testing Library；扩展与关键流程 Playwright（沿用现有 fixtures 与 `e2e-extension`）。
- 现有 `tests/collector.browser.test.js`、`tests/ingestion.test.js` 在迁移过程中保持通过（ingestion 测试改为基于 SQLite 断言）。

## 里程碑

单人开发，**M2 优先**：M5 验收需要至少一周的新版真实数据，M2 完成后用户即在日常 Chrome 中换装新扩展开始积累，同时开发 M3、M4。M6 页面骨架可在 M3 后用 mock 数据先行。

```text
M0 → M1 → M2 扩展（完成后用户换装、开始积累数据）→ M3 工作台基础 → M4 → M5 → M6 → M7
```

### 已确认的开发约定

- 自动整理默认值：每天 23:00 + 攒够 10 条开启，入箱即整理关闭。
- OpenRouter 暂不充值（免费模型合计 50 RPD），备用模型调用需留意额度。
- 开发测试用学习者档案：角色「前端开发」，学习方向「Agent 架构」；用于提示词调试、录制 LLM 响应 fixture 与 M7 评估。
- 测试浏览器 `.browser-profile` 已登录 ChatGPT 与 DeepSeek。

### 需要用户配合的节点

| 时间点 | 事项 |
| --- | --- |
| M2 完成 | 在日常 Chrome 加载新扩展（同意 `webNavigation` / `idle` 权限），正常使用至少一周 |
| M7 | 校对 50–100 条预填的整理判定结果（约 1–2 小时） |
| M7 | 干净环境 `npx study-studio` + 加载扩展验收 |

| 里程碑 | 内容 | 预估（人日） |
| --- | --- | --- |
| M0 | 工程基线与技术验证 | 3 |
| M1 | 本地服务与存储 | 4 |
| M2 | 扩展迁移与行为采集 | 6 |
| M3 | 工作台基础页面 | 6 |
| M4 | AI 网关与检索基础 | 3 |
| M5 | 整理流水线 | 9 |
| M6 | 知识库页面与整理交互 | 5 |
| M7 | 联调、质量评估与交付 | 4 |
| 合计 | | 约 40 |

### M0 工程基线与技术验证

- npm workspaces、TS 配置、lint/format、`npm run check` / `npm test` 统一入口。
- `packages/shared` 建立，先放事件与设置 schema。
- 技术验证（不通过则在本里程碑内换方案，见「风险」）：
  - `node:sqlite` + FTS5（`unicode61` / `trigram`）+ `loadExtension` 加载 sqlite-vec（2026-10-03 已验证：sqlite-vec v0.1.9 加载、trigram 匹配、vec0 KNN 均正常）；
  - AI SDK `generateObject` + Zod discriminated union，按 06「模型选择」对 Ollama `qwen2.5:7b`、Gemini、OpenRouter、Groq 实测结构化输出；
  - WXT 打包 `collector-runtime`，content script 正常采集现有 fixtures。

验收：三项验证有可运行的最小脚本；现有测试通过。

### M1 本地服务与存储（02、03 / 04 / 10 的服务端基础）

- Hono 改造：Host / Origin 校验、配对令牌、工作台一次性登录链接 + Cookie（S23）、静态托管 `/app`。
- 数据库：启动流程（WAL、quick_check、迁移）、`001_init.sql`（02 全部表，**不含** `chat_messages`）、仓储层手写 TS 类型。
- 采集入库：`ingest(event)` 覆盖现有事件 + 01 新增行为事件；`POST /v1/events`、`/v1/events/batch`（逐条结果）、`GET /v1/pages`、`GET /v1/settings`（ETag）、`POST/GET /v1/presence`。
- 服务端排除规则校验、canonical URL 去重、阅读时长规则、`item_exposure` 累加、blobs 存储。
- 不做旧数据迁移：旧版 `timeline/`、`inbox/`、`state/` 目录不读取、不导入，新库从空开始。
- 调度器骨架（croner）：每日备份、回收站过期清理、行为日志过期清理。

验收：批量同步重复提交不重复入库；ingestion 测试全部基于 SQLite 通过。

### M2 扩展迁移与行为采集（01）

- 迁移到 WXT；content script 接入 `collector-runtime`；构建期 `STUDY_STUDIO_DEV` 改为动态设置。
- Service Worker：联通校验（状态缓存 + `chrome.alarms`）、Dexie 离线队列（`pending_events` / `failed_events` / `meta`）、同步器（`navigator.locks`、每批 50 条 / 2 MB）、角标。
- 弹窗：连接状态、待同步知识 n 条、同步按钮与进度、失败查看、备注输入、连接设置。
- 行为记录：`page_session`（合并 `webNavigation` / `tabs` 的跳转关系）、`search_performed`、`selection` / `copy`、`activity_state`（`chrome.idle`）、AI 问答 `conversationId`。
- 内容露出：`IntersectionObserver` 块级计时、章节汇总、随 `page_session` 上报。
- 正文采集规则放宽：搜索结果点入、AI 对话前后 5 分钟内打开的页面。
- `unrelated` 类别隐私处理（只记域名、类别、时长）；「正在学习」心跳。

验收：`e2e-extension` 覆盖「服务停止 → 采集入 IndexedDB → 启动服务 → 自动同步 → 计数归零」；手动同步与 422 失败展示正常；行为事件在库中可查，且不含正文。

### M3 工作台基础页面（03、04、10、11）

- 工程：React 19 + Vite + TanStack Router / Query + Zustand + Radix；原型 `styles.css` 抽 CSS 变量；布局、侧栏、模块状态保留、通用组件（单行省略 + tooltip、编辑态按钮位置、返回按钮）。
- 首页（按上文调整）。
- 收集箱：Tab（全部 / 网页 / 问答）、状态筛选、游标分页、勾选与跨页已选、批量已读 / 标签 / 删除；条目详情（Markdown 渲染、阅读记录、编辑与 `dirty` 提示条、备注卡）；三类备注 CRUD；删除影响预览、回收站与撤销；排除规则。
- 学习进度：时间线（按天聚合、类型筛选）、进度纵览（今日、7 天趋势、来源分布、待处理）、正在学习。
- 设置：采集（正文采集规则、行为记录、黑名单、对话平台、排除规则）、数据与隐私（导出 / 导入 / 重建索引 / 备份 / 重置令牌 / 清空）、学习者档案；AI 与整理规则分区在 M4、M5 补齐。
- 首次启动引导：配对令牌与扩展安装步骤。

验收：日常可用的收集与回顾；删除 → 撤销后数据完全恢复；切换模块再返回时状态保留。

### M4 AI 网关与检索基础（06、02 S7 / S8）

- 服务商 CRUD、`secrets.json`（0600）、测试连接与模型下拉、按任务选模型（学习判定 / 知识处理 / 词条重写 / Embedding）、今日用量与每日上限。
- `gateway.ts`：按任务取模型、`generateObject`（JSON Schema 不支持时降级为「JSON 模式 + 本地校验 + 一次修复重试」）、`embed`、429 / 5xx 退避重试、用量记录与限额检查、提示词版本号。
- 检索基础：`Intl.Segmenter` 预分词 + FTS5（trigram 兜底）、sqlite-vec、`chunks` 索引后台任务、「重建索引」。
- 设置页「AI 模型」分区。

验收：从 `ai-seed.json` 导入 Ollama、Gemini、OpenRouter、Groq 四个服务商并测试连接通过；主模型失败时切到备用模型；超出每日上限时调用被拦截；词条摘要与正文能被向量和关键词检索到。

### M5 整理流水线（07）

| 步骤 | 实现要点 |
| --- | --- |
| 队列与触发 | `organize_jobs` 表 + 单 worker；定时 / 攒够 N 条 / 入箱即整理 / 手动；多触发合并；补跑；限额暂停与次日继续；SSE `GET /v1/organize/events` 推送进度 |
| ① 上下文加载 | 锚点窗口、学习者档案、近期入库主题、三类备注与整理要求 |
| ② 片段切分 | 纯函数：域名类别、硬切分、缝合、分心标记、预过滤、`open` 推迟、生成行为摘要 |
| ③ 学习判定 | 提示词 + schema（含 `item_engagement`）；置信度分支；`segment_suggestion` 最多修正一轮；备注 / 高亮兜底 |
| ④ 检索与预过滤 | 条目级 + 片段级查询、两路召回、时间衰减打分；SimHash 近重复、相似度阈值、导航页 / 低信息、`kb_ignore`；`route=prefilter` 记录 |
| ⑤ 知识处理 | 输入组装（正文露出权重、top-2 词条附正文、一跳邻居、分类）；discriminated union schema；engagement 门槛 τ 兜底；采纳模式；长文两步路径；问答按会话线程组装 |
| ⑥ 知识入库 | 对齐校验（归一化、名称 embedding > 0.92）；补丁应用器（三种 op、标题找不到时的降级）；`user_edited` 写「整理建议」段；单条目事务；同步更新摘要向量，异步更新正文块 |
| ⑦ 整理记录 | 词条全量重写（手动 / `stale` / 全量）；`patch_count`；收集箱状态；`organize_runs` 统计 |
| 其他 | `input_hash` 增量；单条失败不阻塞；重试失败项；路径捷径（手动所选、未采纳采纳、知识点重新整理） |

- API：`GET/PUT /v1/organize/settings`、`POST /v1/organize/run`、`GET /v1/organize/runs`、`POST /v1/organize/runs/:id/retry`、`GET /v1/organize/events`。
- 测试：② 与补丁应用器写纯函数单测；③⑤ 用录制的 LLM 响应回放，覆盖各 decision 分支、兜底阈值、采纳模式、长文路径、`user_edited` 保护、`stale` 重写。

验收：用新采集的真实数据（至少一周）跑一次全量整理，无失败中断；同一批数据再次自动整理全部按 `input_hash` 跳过；删除条目后相关词条正确进入 `stale` 并在下次整理时被重写。

### M6 知识库页面与整理交互（08、03、10）

- 知识库：目录（分类 + `part_of` 递归嵌套、掌握度、`stale` / `user_edited` / 无来源标记、搜索与类型筛选、多选）、右侧预览面板。
- 词条详情：react-markdown + remark-gfm + KaTeX + shiki 渲染；程序渲染「与 X 的区别」「常见疑问」；侧栏（掌握度、知识点备注、来源与 evidence、关联词条）；CodeMirror 6 编辑；删除影响预览与 `kb_ignore`；「建议重新整理」提示。
- 整理交互：整理弹窗（范围选项、使用的备注数、整理要求与快捷 chip）、侧栏进度、完成 toast、收集箱与详情页的待整理提示条。
- 整理记录页（`#/runs`）与设置「整理规则」分区。
- 掌握度自动估算与手动设定。

验收：从收集箱发起整理到知识库出现词条全流程可用；手动编辑词条后再次整理，正文不被覆盖，只追加「整理建议」。

### M7 联调、质量评估与交付（11）

- 整理质量评估：取 50–100 条真实条目，人工标注期望结果，对比学习判定、预过滤与知识处理的输出；校准相似度阈值（0.55 / 0.93 / 0.92）、τ、`patch_count` 提示阈值，并记录评估结论。
- 关键流程 Playwright 用例：采集 → 同步 → 收集箱 → 整理 → 知识库。
- 交付：npm 包 `study-studio`（`npx study-studio`、`--data-dir`、`--port`）、Node 版本检测、服务托管 `apps/workbench/dist`、扩展 `wxt zip`；README 更新。
- 可选（时间允许）：开机自启（S22）。

验收：干净环境 `npx study-studio` + 加载扩展可完成完整闭环；评估结论写入文档。

## 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| `node:sqlite` 加载 sqlite-vec 失败或不稳定 | 向量检索不可用，④ 召回变差 | M0 验证；失败时向量检索降级为 JS 内存暴力计算（个人数据量可接受），接口不变 |
| 本地小模型结构化输出不稳定 | 学习判定失败率高 | 降级重试机制；学习判定允许改选云端便宜模型；置信度结合 `signals_observed` 规则校正 |
| 知识处理单次输出过长（新词条正文 + 补丁） | 输出截断、schema 校验失败 | 限制单次新词条数量（如 ≤ 5），超出的概念只建摘要，正文留待重写；输出 token 上限按模型配置 |
| 补丁质量差、正文结构逐渐变乱 | 词条可读性下降 | `replace_section` 原文存档可回滚；`patch_count` 提示重新整理；M7 评估时重点抽查 |
| `webNavigation` / `idle` 等新权限 | 用户安装时权限提示增多 | 弹窗与 README 说明用途；数据只发往 127.0.0.1 |
| 行为事件量大 | IndexedDB 与 `events` 表膨胀 | 行为日志保留 14 天；`page_session` 合并上报，不按秒上报 |
| 迁移 TS 与 WXT 期间破坏现有采集 | 采集中断 | 现有 Playwright fixtures 作为回归基线，每个里程碑必须通过 |

## 完成标准

- `npm run check`、`npm test` 与关键 Playwright 用例通过。
- 01–08、10、11 中标为本期的功能全部可用；09 的入口在界面上不出现。
- 整理质量评估结论与校准后的阈值写回 07。
