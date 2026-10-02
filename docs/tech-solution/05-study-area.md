# 05 学习区（文档阅读与采集）

> **本期不做**（S18、S19 随之跳过）。本文件保留为后续实现参考；本期侧栏不显示学习区，收集箱无文档类型，时间线无文档阅读行。

## 功能

- 拖入或选择 PDF / PPT / PPTX；文件存 `blobs/`，生成 `items(type=document, is_strong_learning=1)`，进入收集箱。
- 我的文档：已读页数/总页数、累计时长、进度条、继续阅读（记住上次页码）。
- 阅读器：缩略图栏、翻页、页面渲染、右侧「本页高亮与备注」、阅读进度；顶部「记录中 · 本次时长」。
- 网页不在工作台预览，继续由浏览器扩展采集。

## 采集规则

阅读器内嵌一个采集适配层，输出与扩展相同的事件结构（`source.channel = "workbench"`），直接调用服务内部入库函数（同源 API `POST /v1/events`）：

| 行为 | 事件 |
| --- | --- |
| 上传完成 | `document_captured`（新事件类型，含文件元数据与抽取文本引用） |
| 页面可见 ≥ 10 秒 | 标记该页已读（`doc_read_pages` 去重累加） |
| 离开阅读器 / 切后台 / 30 秒无交互 | `reading_session_closed`（含页码范围），时长规则同网页 |
| 选中文本后添加备注 | `user_note`（`scope=item`，带页码与引用原文） |
| 高亮 | 存为带位置的备注（`meta.highlight = { page, rects, quote }`） |

页面可见性用 `IntersectionObserver`（阈值 0.6）+ `document.visibilityState`。

## 文本抽取（供检索与整理）

- 上传后后台任务抽取全文，按页写入 `item_contents.plain_text`（页分隔符）与 `chunks`。
- 扫描版 PDF 无文本层：标记「无可检索文本」，OCR 作为后续增强（候选 tesseract.js，不在本期）。

## 选型

### S18 PDF 阅读

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ react-pdf（wojtekmaj，基于 pdf.js） | React 组件化 `<Document>/<Page>`，文本层与注释层开箱即用；逐页渲染便于做可见性统计；社区最大 | 高亮需自己在文本层上实现（或叠加 react-pdf-highlighter-extended） |
| pdfjs-dist 直接使用 | 完全控制、无封装开销 | 渲染、文本层、缩放、虚拟化全部自写 |
| 嵌入 PDF.js 官方 viewer（iframe） | 功能最全（搜索、缩放、大纲） | 难以定制成原型样式；阅读行为与高亮采集要改 viewer 源码 |
| EmbedPDF（PDFium wasm） | 新一代，插件化（注释、搜索），渲染保真度高 | 较新，生态与稳定性待验证；wasm 体积大 |

服务端抽取文本：`unpdf`（pdf.js 的无 DOM 构建，零原生依赖）优于 `pdf-parse`（基于旧版 pdf.js，维护弱）。

### S19 PPT / PPTX

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ 首版文本抽取按页渲染 + 检测到 LibreOffice 时转 PDF 复用阅读器 | 零强依赖；有 LibreOffice 的用户得到原样式 | 无 LibreOffice 时只有文本版式 |
| 浏览器直接渲染 pptx（pptx-preview / PPTXjs） | 无需外部软件，有视觉效果 | 复杂版式、SmartArt、字体保真度一般；库维护度参差 |
| 强制依赖 LibreOffice（headless 转 PDF） | 保真度最好，阅读器只需支持 PDF | 需用户安装约 500 MB 软件，开源上手门槛高 |

文本抽取库：`officeparser`（纯 JS，支持 pptx/docx/pdf）或用 JSZip 解析 `ppt/slides/*.xml` 自写（更可控，可保留每页标题/列表层级）。推荐自写，按页输出。旧版 `.ppt`（二进制格式）仅在有 LibreOffice 时支持。
