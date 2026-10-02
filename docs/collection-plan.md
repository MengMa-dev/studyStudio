# 学习内容采集：首版方案与实施路线

## 已确认范围

- 采集器独立于宿主，可在浏览器扩展 Content Script 和桌面端内置浏览器注入环境中运行。
- 两个宿主都遵循同一学习门槛；桌面端不因“强学习”而绕过门槛。桌面端仅提供更高的基础学习信号。
- 时间线只记录学习行为（提问、回答、入箱网页、备注、有效阅读时长）；单纯打开页面不写入。仅达到学习门槛的完整页面/问答写入本地 `inbox`。
- 首版支持 ChatGPT、DeepSeek 对话网页和普通 HTML 页面；不支持 PDF。
- 首版对话事件仅有“用户发送问题”和“AI 回答完成”。不做流式中断补采、历史回补、重新生成、编辑和分支。
- 原始采集内容、整理结果和索引严格分离；采集器不调用 LLM、不写文件、不判断知识价值。

## 运行时边界

```text
collector-contract / collector-runtime
  ├─ 标准浏览器 DOM 与事件 API
  ├─ 输出 CollectorEvent
  └─ 不依赖 chrome、Electron、Tauri、文件系统或 LLM

browser-extension / desktop bridge
  ├─ 注入 collector runtime
  ├─ 提供 send(event) 回调
  └─ 与本地服务配对并发送事件

local-ingestion
  ├─ 校验、去重、写入本地目录
  └─ 之后由整理服务异步读取 inbox
```

## 事件与落盘

```text
page_opened                 → 不落盘（扩展端不发送）
user_message_sent           → timeline/YYYY-MM-DD.jsonl
assistant_response_completed→ timeline + inbox/conversations/qa-*/
webpage_captured            → timeline + inbox/webpages/page-*/（同一 canonical URL 只入箱一次）
user_note                   → timeline/YYYY-MM-DD.jsonl
reading_session_closed      → 仅已入箱页面的有效停留：timeline + 累加到 metadata.json 的 readingStats
```

阅读时长按页面可见时间计算：入箱那次停留全额计入；之后每次停留可见时间 ≥ 60 秒才累加，否则不记录。

`inbox` 的原始内容是事实源；将来的 `system` 索引、摘要和知识图谱均可从中重建。

## 学习门槛

普通页面在任意宿主中满足以下任一条件时入箱：

1. 活跃阅读至少 90 秒且最大滚动深度至少 35%；
2. 用户在当前页面记录备注；
3. 用户复制、划词或高亮。

已入箱的 canonical URL 再次打开时不会重复采集。列表页不入箱：站点适配器可声明 `isContentPage` 白名单（如知乎仅问题/回答/专栏文章），其余站点按首页、搜索、标签/分类等 URL 规则，以及正文链接占比过高、没有一段成段正文、重复短卡片结构等规则判定。

桌面端会在事件的 `isStrongLearning` 中标记为强学习来源，供后续整理评分使用，但不改变上述入箱条件。

## 内容提取

普通网页使用如下级联：站点适配器 → Defuddle → Mozilla Readability → `main/article/[role=main]` 兜底。首版运行时已经实现无依赖的 DOM 兜底；接入 Defuddle/Readability 时替换 `extractPageContent` 即可。输出同时保存 Markdown、清洗 HTML、纯文本、标题和资源引用。

对话使用平台适配器识别输入框、用户消息、AI 消息和生成状态。回答完成后提取 Markdown、纯文本、清洗 HTML、代码块、表格、链接、图片引用；复杂图表在下一步加入截图资源兜底。

## 实施顺序

1. 完成采集契约、浏览器无关运行时、本地 Ingestion Service 和端到端演示。
2. 完成浏览器扩展最小桥接：配对、发送事件、备注入口。
3. 完成桌面端最小桥接：将同一运行时注入 WebView / WebContents，并发送到相同本地服务。
4. 接入 Defuddle、Readability、DOMPurify 与 Playwright fixture 回归测试。
5. 扩展 ChatGPT、DeepSeek 和高频网页站点适配器，之后才进入 LLM 整理和知识图谱。

## 实施状态（首版）

1–5 已完成，`npm test` 覆盖：

- 运行时：`installCollector` 统一入口，按 URL 选择对话/网页采集器并跟随 SPA 导航；三类入箱门槛全部实现；宿主经本地服务 `GET /v1/pages?canonicalUrl=` 查询页面是否已入箱，扩展与桌面共享同一索引。
- 对话：提问通过 Enter/发送按钮或“新增用户消息 + 输入框曾有内容”识别；回答需在该问题之后、非生成状态且内容稳定两次检查才完成，不回补历史。DeepSeek 思考过程单独存为 `answer.reasoning`。
- 提取：站点适配器（GitHub、MDN、Wikipedia、Stack Overflow、知乎、掘金、CSDN、博客园）→ Defuddle → Readability → DOM 兜底；统一输出 Markdown（含代码语言、GFM 表格、KaTeX 公式）、清洗 HTML、纯文本、代码块、表格、链接与图片引用。
- 本地服务：按事件类型校验；事件 ID 与网页 canonical URL 去重可跨重启；时间线只存元数据与 `artifact` 引用，正文仅在 inbox。
- 扩展：离线事件队列与自动重发、连接状态检查。桌面：`dist/collector-inject.js` 注入包 + `StudyStudioHost` 宿主接口。

已知限制：ChatGPT/DeepSeek 适配器基于当前 DOM 结构与 fixture 验证，平台改版后需更新选择器与 fixture；复杂图表截图兜底尚未实现。
