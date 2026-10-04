# Study Studio 技术方案（终版）· 00 总览

本目录是开发依据，取代 `docs/workbench-plan.md`；`docs/collection-plan.md` 中采集运行时部分继续有效。UI 与交互以 `prototype/workbench/` 为设计稿（本期不做的模块见下文「本期范围」）。

## 文档索引

| 文件 | 业务领域 | 本期 |
| --- | --- | --- |
| `01-collection-sync.md` | 采集与扩展离线同步（IndexedDB、联通校验、待同步按钮） | 做 |
| `02-local-service-storage.md` | 本地服务与 SQLite 存储（取代文件目录） | 做 |
| `03-inbox-notes.md` | 收集箱、三类备注、删除与回收站、排除规则 | 做 |
| `04-progress-timeline.md` | 学习进度与时间线 | 做 |
| `05-study-area.md` | 学习区（PDF / PPT 阅读与采集） | **不做**，保留为后续参考 |
| `06-ai-gateway.md` | AI 配置与模型网关 | 做 |
| `07-organize.md` | 整理流水线（LLM → 知识库） | 做 |
| `08-knowledge-base.md` | 知识库（目录 + 词条 + 图谱） | 做（图谱实施见 14） |
| `09-chat.md` | 首页对话与悬浮对话 | 第二期做（见 13） |
| `10-settings-data.md` | 设置、数据与隐私 | 做 |
| `11-frontend-delivery.md` | 前端工程、扩展工程、打包交付、测试 | 做 |
| `12-implementation-plan.md` | 本期实施方案：范围、里程碑、验收、风险 | — |
| `13-chat-implementation-plan.md` | 对话实施方案：范围、里程碑 C1–C6、验收、风险 | — |
| `14-kb-graph-implementation-plan.md` | 知识图谱 + 动态词条类型：方案、里程碑 G1–G6 | — |
| `15-organize-multistep.md` | 整理 ⑤ 多轮处理（判定 → 分块抽取 → 对齐写作 → 覆盖校验）与 ⑦ 基于知识点重写 | 做 |
| `16-agent-organize-mcp.md` | 外部 Agent 整理：本地 `/mcp` 工具 + `organize-kb` skill + 设置页「Agent 接入」 | 做 |

## 本期范围

- 不做：**学习区**（文档上传、PDF/PPT 阅读与采集、`document` 条目类型、`document_captured` 事件）、**首页对话与悬浮对话**（首页去掉输入框，保留入口卡片；调整明细见 12）。知识图谱可视化与动态词条类型已转为本期（见 14）。
- 原型中对应的处理：侧栏不显示「学习区」；收集箱无「文档」Tab；时间线无「文档阅读」行。
- 数据层预留：`items.type` 保留 `document` 枚举、`kb_edges` 照常写入（关联词条与目录嵌套依赖它），后续上线学习区与图谱无需迁移。

## 本次方案变更

1. **扩展离线暂存改为 IndexedDB**：采集前做服务联通校验，可联通直接发送；不可联通写入 IndexedDB；恢复联通后自动从 IndexedDB 取出发送，服务确认后删除，也可在弹窗手动同步。
2. **存储改为 SQLite**：本地服务启动即打开（嵌入式，无独立进程）`StudyStudioData/studystudio.db`，采集数据不再写 `timeline/*.jsonl` 和 `inbox/` 目录。SQLite 成为唯一事实源；只有二进制文件（网页图片资源等）按内容哈希存到 `blobs/`，由库表引用。
3. **扩展弹窗新增同步区**：显示「待同步知识 n 条」、说明文字和「同步到 Study Studio」按钮，图标角标显示待同步数。
4. **采集分层 + 学习判定**：采集层全量记录行为元数据（活动轨迹 + 学习信号），正文仍按正文采集规则采集（见 01）；整理阶段先切分活动片段，经学习判定（只看行为）、规则预过滤，再由一次知识处理调用完成判定、抽取、对齐与词条补丁，最后程序写库（见 07）。收集箱整理状态改为待整理 / 已入库 / 未采纳；新增学习者档案（见 10）。`docs/collection-plan.md` 中「单纯打开页面不写入」的约定由本条取代。

## 总体架构

```text
┌───────────── 浏览器 ─────────────┐        ┌──────────── 本地服务 (Node, 127.0.0.1:43118) ────────────┐
│ Content Script                   │        │ HTTP 层（Hono）：鉴权 / Host·Origin 校验 / 静态托管 /app  │
│  collector-runtime（现有）        │ event  │ ├─ 采集 API   /v1/events, /v1/events/batch, /v1/pages   │
│        │ chrome.runtime          │ ─────▶ │ ├─ 工作台 API /v1/workbench/*, /v1/notes, /v1/kb/*      │
│ Service Worker                   │        │ ├─ AI / 整理 /v1/ai/*, /v1/organize/*                   │
│  联通校验 → 直发 / IndexedDB      │ ◀───── │ ├─ 对话 SSE  /v1/chat                                   │
│  同步器（自动 + 手动按钮）         │settings│ 领域服务：采集入库 / 收集箱 / 备注 / 时间线 /             │
│ Popup：状态、待同步 n 条、同步按钮 │        │          整理队列 / 知识库 / 检索 / 对话 / 设置          │
└──────────────────────────────────┘        │ 存储：node:sqlite(WAL) + FTS5 + sqlite-vec；blobs/       │
┌──────────── 工作台 (React SPA) ───┐        │ 调度：整理定时 / 攒够数量 / 补跑；回收站清理；每日备份     │
│ 首页对话 · 知识库 · 学习进度 ·     │ ─────▶ └───────────────────────────────────────────────────────────┘
│ 收集箱 · 设置 · 悬浮对话           │                         │ 仅整理/对话时
└──────────────────────────────────┘                         ▼
                                                 模型服务商（OpenAI 兼容 / Anthropic / Ollama）
```

## 技术栈（已确认）

| 层 | 选定 |
| --- | --- |
| 扩展 | WXT + Dexie.js（IndexedDB） |
| 本地服务 | Node ≥ 22.13 + Hono |
| 数据库 | `node:sqlite` + 手写 SQL 迁移；FTS5 + `Intl.Segmenter` 预分词（trigram 兜底）；sqlite-vec |
| 模型网关 | Vercel AI SDK |
| 整理 | 自研 TS 流水线（参考 LightRAG 思路）+ SQLite 任务表 + croner |
| 前端 | React + Vite + TS + TanStack Router/Query + Zustand + Radix 原语 + 原型 CSS 变量 |
| 编辑与渲染 | CodeMirror 6（Markdown）；react-markdown + remark-gfm + KaTeX + shiki |
| 对话 | AI SDK UI `useChat` + 自研界面 |

## 选型结论

| # | 事项 | 结论 | 方式 |
| --- | --- | --- | --- |
| S1 | 离线队列同步时机 | 自动 + 手动按钮 | 已确认 |
| S2 | IndexedDB 封装 | Dexie.js | 按推荐 |
| S3 | 扩展工程框架 | WXT | 按推荐 |
| S4 | SQLite 驱动 | `node:sqlite` | 已确认 |
| S5 | 数据访问层 | 手写 SQL + 自研迁移 | 按推荐 |
| S6 | HTTP 框架 | Hono | 已确认 |
| S7 | 中文全文检索 | Intl.Segmenter 预分词 + trigram 兜底 | 按推荐 |
| S8 | 向量检索 | sqlite-vec | 按推荐 |
| S9 | 二进制文件存储 | `blobs/` 目录 | 按推荐 |
| S10 | 模型网关 | Vercel AI SDK | 已确认 |
| S11 | API Key 存储 | `secrets.json`（0600） | 按推荐 |
| S12 | 知识抽取方案 | 自研 TS 流水线 | 已确认 |
| S13 | 任务队列与定时 | SQLite 任务表 + croner | 按推荐 |
| S14 | 图谱可视化 | Cytoscape.js + cytoscape-fcose | 已确认 |
| S15 | 目录树组件 | 自研 | 按推荐 |
| S16 | 内容编辑器 | CodeMirror 6 | 已确认 |
| S17 | 对话 UI 与流式 | useChat + 自研 UI | 按推荐 |
| S18 | PDF 阅读 | 随学习区跳过 | 已确认 |
| S19 | PPT 处理 | 随学习区跳过 | 已确认 |
| S20 | UI 组件基础 | Radix 原语 + 原型 CSS 变量 | 已确认 |
| S21 | 前端路由 | TanStack Router | 按推荐 |
| S22 | 服务常驻方式 | 手动启动 + 可选开机自启 | 按推荐 |
| S23 | 工作台鉴权 | 一次性登录链接写 Cookie | 按推荐 |
| S24 | 词条类型 | 种子类型 + LLM 动态扩展（上限 20），`kind` 存中文名 | 已确认 |

## 阶段计划

本期按 `12-implementation-plan.md` 的里程碑 M0–M7 推进：工程基线 → 本地服务与存储 → 扩展迁移 / 工作台基础（并行）→ AI 网关与检索 → 整理流水线 → 知识库页面 → 联调交付。

| 阶段 | 内容 |
| --- | --- |
| 本期 | 采集、存储、收集箱、学习进度、AI 网关、整理、知识库（目录 + 词条）、设置 |
| 第二期 | 首页对话与悬浮对话（09，实施见 13） |
| 本期追加 | 知识图谱、动态词条类型（14） |
| 后续 | 学习区（05）、复习、桌面端 |
