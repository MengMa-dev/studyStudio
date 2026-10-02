# 01 采集与扩展离线同步

## 范围

- 沿用：`collector-runtime`（门槛判定、网页提取级联、ChatGPT/DeepSeek 适配器、SPA 导航）、`collector-contract`（事件校验）、content script 与 service worker 的消息桥。
- 新增：服务联通校验、IndexedDB 离线队列、自动/手动同步、弹窗同步区与角标、动态设置拉取、「正在学习」心跳。
- 移除：`chrome.storage.local.pendingEvents`（上限 500 条）。

## 采集分层

扩大的是**行为元数据**的采集范围，正文采集仍收紧。是否学习、是否入库由整理阶段判断（见 07），采集层不做判断。

| 层 | 英文 | 范围 | 内容 | 用途 |
| --- | --- | --- | --- | --- |
| 活动轨迹 | Activity Trace | 全量 | 页面会话、跳转、空闲/失焦 | 片段切分、分心与回归 |
| 学习信号 | Learning Signals | 全量 | 搜索、划选/复制文本片段、AI 问答、笔记 | 学习判定 |
| 正文采集 | Content Capture | 满足正文采集规则 | 网页正文 | 知识处理（判定与抽取） |

- 前两层合称**行为记录**（Activity Tracking），存为行为日志，不在收集箱、时间线展示。
- **正文采集规则**（Capture Rules，原「学习门槛」）只决定是否抓正文，不决定是否记录行为。规则偏宽松（宁多勿漏）：停留与滚动达到门槛；复制、划选、笔记；从搜索结果点入；AI 对话前后 5 分钟内打开的页面。
- 隐私：命中 `unrelated` 类别（社交、购物、娱乐，内置 + 用户黑名单）的页面只记录域名、类别与时长，不记录 URL 路径与标题；排除规则命中的页面完全不记录。

### 新增事件（行为记录）

| 事件 | 时机 | 主要字段（均不含正文） |
| --- | --- | --- |
| `page_session` | 页面会话结束（关闭 / SPA 导航 / 切走超过 30 分钟） | `tabId`、url、domain、title、h1、metaDescription、`referrer`、`openerTabId`、`transition`（link / typed / back_forward / reload）、开始/结束时间、可见秒数、最大滚动深度、`revisit`、`captured`（是否触发了正文采集） |
| `search_performed` | 搜索结果页加载 | `engine`（google / bing / baidu / github / 站内）、`query`、`tabId`；之后从结果页点入的 `page_session.referrer` 指向该搜索 |
| `selection` / `copy` | 划选 ≥ 2 字 / 复制 | 文本片段（截断 500 字）、是否代码块、所在页面 url |
| `activity_state` | 系统空闲 / 恢复、浏览器失焦 / 聚焦 | `state`（idle / active / blur / focus）；空闲用 `chrome.idle`（阈值 60 秒） |

- AI 问答事件新增 `conversationId`（从会话 URL 解析），用于整理时按会话线程合并多轮问答。
- `page_session` 取代「`reading_session_closed` 只在已入箱页面发送」的限制：所有页面都发会话结束事件；`reading_session_closed` 保留，口径不变，用于阅读统计。
- 导航关系依赖 `chrome.tabs` / `chrome.webNavigation`（`onCommitted` 的 `transitionType`、`onCreatedNavigationTarget` 的来源 tab），由 service worker 合并进 `page_session`。

### 内容露出（Content Exposure）

统计正文中每块内容在可视区实际露出的时长，用于整理时区分内容权重（见 07）。只对普通页面生效（AI 对话页不统计）。

- **监听单元**：正文容器内的块级元素（`h1–h6`、`p`、`li`、`pre`、`table`、`blockquote`），用 `IntersectionObserver`（`threshold: 0.5`）；正文容器沿用页面提取器的定位结果。动态加载的内容由 `MutationObserver` 发现后补充监听。
- **计时条件**（同时满足）：元素露出 ≥ 50%；标签页可见且窗口聚焦；60 秒内有滚动 / 鼠标 / 键盘操作（否则视为离开）；单次连续露出 ≥ 1 秒（过滤快速滚动带过）。
- **章节汇总**：块按最近的上级标题归入章节（无标题时按每 5 个块分组）：

```text
coverage = min(1, exposed_seconds / expected_seconds)
expected_seconds = 章节字数 / 阅读速度（中文 400 字/分钟，英文 200 词/分钟）
```

- **与正文对应**：每个块取规范化后前 50 字作为指纹（`fp`），整理时匹配 Markdown 段落；章节以标题指纹作为 `key`。
- **上报**：随 `page_session` 上报会话内最终结果（正文可能在会话中途已采集，露出继续累计），字段 `exposure`：

```json
{
  "sections": [
    { "key": "fp:persistence-overview", "heading": "Persistence", "chars": 1800, "exposed_seconds": 210, "coverage": 0.78 },
    { "key": "fp:checkpointer-libraries", "heading": "Checkpointer libraries", "chars": 2400, "exposed_seconds": 0, "coverage": 0 }
  ],
  "top_blocks": [{ "fp": "interrupt() pauses graph execution", "exposed_seconds": 45 }],
  "page_coverage": 0.41
}
```

- 数据量：只报章节汇总 + 露出最长的前 10 个块，不报全部块明细；章节数上限 100。
- 限制：iframe 与部分 Shadow DOM 内容监听不到，退回整页的 `maxScrollDepth`；露出 ≠ 读过，只作中等信号。

## 事件流

```text
content script ──event──▶ service worker
                           │
                           ├─ 1. 过滤：page_opened 等不发送；命中排除规则（缓存）不发送
                           ├─ 2. 联通状态 = online ?
                           │      ├─ 是：POST /v1/events（超时 3s）
                           │      │      ├─ 2xx / 422（永久失败）→ 结束
                           │      │      └─ 网络错误 / 超时 / 401 / 5xx → 写 IndexedDB，状态置 offline|unauthorized
                           │      └─ 否：直接写 IndexedDB
                           └─ 3. 更新角标与弹窗计数
```

## 联通校验

| 状态 | 判定 | 弹窗表现 |
| --- | --- | --- |
| `online` | `GET /v1/pairing` 200 | 绿点「已连接 Study Studio」 |
| `unauthorized` | 401 | 橙点「配对令牌无效」，引导重新填写 |
| `offline` | 网络错误 / 超时 | 灰点「本地服务未启动」，提示 `npx study-studio` |
| `unknown` | 尚未检测 | — |

- 状态缓存在 service worker 内存 + `chrome.storage.session`（SW 被回收后可恢复），附 `checkedAt`。
- 检测时机：SW 启动（`onStartup` / `onInstalled`）、弹窗打开、发送失败后、`chrome.alarms` 周期检测（存在待同步数据时每 1 分钟；无待同步时每 5 分钟，`alarms` 最短周期 30 秒）。
- 发送前不额外请求健康检查：缓存为 `online` 时直接带超时发送，失败即降级；缓存为 `offline` 且 `checkedAt` < 30 秒时直接入队，避免每个事件都等超时。
- MV3 service worker 空闲约 30 秒会被终止，所有状态不能只放内存；定时依赖 `chrome.alarms`，不能用 `setInterval`。

## IndexedDB 设计

数据库 `study-studio`，存储：

| store | 主键 | 字段 | 索引 |
| --- | --- | --- | --- |
| `pending_events` | `seq`（自增） | `event`（完整事件）、`eventId`、`type`、`occurredAt`、`attempts`、`lastError`、`enqueuedAt` | `eventId`（唯一）、`type` |
| `failed_events` | `eventId` | 服务返回 422 的事件与错误原因（不再重试，弹窗可查看/清除） | — |
| `meta` | key | 设置缓存、`settingsEtag`、本地已入箱 URL 缓存 | — |

- 顺序：按 `seq` 升序同步，保证 `webpage_captured` 先于同页 `reading_session_closed`、`user_message_sent` 先于 `assistant_response_completed`。
- 幂等：服务端以事件 `id` 唯一约束去重；同步过程中断重发不会重复入库。
- 删除时机：仅在服务返回该事件 `accepted` 或 `duplicate` 后，在同一事务里按 `seq` 删除。
- 容量：manifest 增加 `unlimitedStorage` 权限；单条事件大小沿用服务端 20 MB 上限。超过 5000 条时弹窗提示尽快启动服务（不丢弃）。
- 离线去重：离线时 `lookupPage` 先查 `pending_events` 中同 `canonicalUrl` 的 `webpage_captured`，命中则视为已入箱；服务端同步时仍按 canonical URL 去重（返回 `duplicatePage`）。
- 风险说明（弹窗文案体现）：卸载扩展或清除浏览器数据会清空 IndexedDB 中未同步的内容。

## 同步器

- 触发：联通状态从非 `online` 变为 `online`（自动，取决于 S1 选型）、弹窗按钮「同步到 Study Studio」（手动）、SW 启动。
- 单实例：用 `navigator.locks.request("study-studio-sync")` 防止并发同步。
- 批量：每批最多 50 条或 2 MB，调用 `POST /v1/events/batch`；响应逐条结果：

```json
{ "results": [ { "id": "evt-1", "status": "accepted" }, { "id": "evt-2", "status": "duplicate" }, { "id": "evt-3", "status": "rejected", "error": "content.markdown is required" } ] }
```

- `accepted` / `duplicate` → 删除；`rejected` → 移入 `failed_events`；整批 401 / 5xx / 网络错误 → 停止，保留剩余，状态降级。
- 进度：同步中通过 `chrome.runtime` 消息推送 `{ done, total }` 给弹窗。

## 弹窗与角标

```text
┌ Study Studio ───────────────────────┐
│ ● 本地服务未启动                      │
│                                      │
│ 待同步知识  12 条                     │
│ 另含 30 条阅读与提问记录               │
│ 本地服务未启动时，采集内容先暂存在浏览器；│
│ 启动 Study Studio 后会自动同步，也可手动同步。│
│ [ 同步到 Study Studio ]   (离线时禁用，悬停提示) │
│ 同步失败 1 条 · 查看                   │
│──────────────────────────────────────│
│ 记一条学习备注… [保存备注]              │
│ 连接设置 ▸（服务地址、配对令牌）          │
└──────────────────────────────────────┘
```

- 「知识」计数口径：`webpage_captured`、`assistant_response_completed`、`user_note`；`user_message_sent`、`reading_session_closed` 计入「另含 n 条记录」；行为记录事件（`page_session`、`search_performed`、`selection`、`copy`、`activity_state`）不计数，只随同步发送。
- 角标：`chrome.action.setBadgeText` 显示待同步知识数（0 时清空）；离线时角标背景灰色，令牌无效橙色。
- 同步完成 toast：「已同步 12 条知识到 Study Studio」。

## 动态设置

- `GET /v1/settings`（带 `If-None-Match`）返回正文采集规则、行为记录开关、无关站点黑名单、对话平台开关、排除规则、内置列表页规则与域名类别版本。
- 拉取时机：SW 启动、弹窗打开、每 5 分钟 alarm；结果缓存到 IndexedDB `meta`，离线时使用缓存。
- content script 安装采集器时从 SW 获取设置，替代构建期 `STUDY_STUDIO_DEV`。

## 正在学习（心跳）

学习进度页「正在学习」需要实时数据：content script 在页面可见且已通过列表页判定时，每 15 秒 `POST /v1/presence`（标题、URL、本次可见秒数、是否已入箱）。只存服务内存，不入库，离线直接丢弃，不进队列。

## API（服务端新增）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /v1/events/batch` | 批量入库，逐条返回结果；单批 ≤ 50 条 / 2 MB |
| `POST /v1/presence` | 正在学习心跳 |
| `GET /v1/settings` | 扩展读取采集设置，支持 ETag |

## 选型

### S1 离线数据同步时机

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ 自动 + 手动按钮 | 服务一启动数据即入库，学习进度实时；按钮用于立即触发和失败重试 | 用户对「何时同步」感知弱（以 toast 与计数弥补） |
| 仅手动按钮 | 用户完全掌控 | 忘记点击会导致工作台数据缺失、整理延迟；离线期间重复入箱判断不准 |

### S2 IndexedDB 封装

| 方案 | 体积 | 优点 | 缺点 |
| --- | --- | --- | --- |
| ★ Dexie.js 4 | ~25 KB gz | 事务、索引、批量删除、`liveQuery`（弹窗计数实时刷新）、版本迁移成熟，SW 环境可用 | 体积最大 |
| idb（Jake Archibald） | ~1 KB | Promise 化原生 API，极轻 | 迁移、批量、查询需自己写 |
| 原生 IndexedDB | 0 | 无依赖 | 回调式 API，样板代码多，易错 |
| localForage | ~8 KB | KV 简单 | 无索引与事务控制，维护基本停滞，不适合有序队列 |

### S3 扩展工程框架（与 11 共用）

见 `11-frontend-delivery.md`。
