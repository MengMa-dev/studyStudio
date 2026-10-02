# 11 前端工程、扩展工程、交付与测试

## 仓库结构（目标）

```text
apps/
  workbench/              React SPA（构建产物由服务托管在 /app）
  browser-extension/      扩展（WXT 工程）
  desktop/                桌面桥接（暂缓，保留注入包）
packages/
  collector-contract/     事件类型与校验（扩展与服务共用）
  collector-runtime/      采集运行时（现有）
  shared/                 API 类型、Zod schema（前后端共用）
services/
  local-ingestion/        本地服务（改名 server 可选）
    src/ http/ db/ migrations/ domains/{capture,inbox,notes,timeline,organize,kb,chat,settings,data}/ ai/ jobs/
```

全仓库迁移到 TypeScript（服务端用 Node 原生类型剥离或 tsx 运行，构建用 tsup/esbuild）。

## 工作台前端

- React 19 + Vite + TypeScript；TanStack Query 管理服务端数据；Zustand 管理跨页 UI 状态（已选集合、悬浮对话开合、整理进度）。
- 样式：把原型 `styles.css` 的颜色、间距、圆角、阴影抽成 CSS 变量，组件用 CSS Modules；交互组件（Dialog、Popover、Tooltip、DropdownMenu、Checkbox、Switch、Tabs）用 Radix 无样式原语。
- 原型中确定的通用规范：
  - 页面头部/操作栏固定，仅内容区滚动；列表滚动在卡片内。
  - 单行标题省略 + tooltip（时间线、收集箱、知识库目录）。
  - 编辑态「保存/取消」出现在原「编辑」按钮位置。
  - 返回按钮统一样式、文案「返回」、回到上一级。
  - 悬浮对话按钮为圆形 icon。
- **模块状态保留**：切换模块再返回时回到离开时的子页面与状态。实现：每个模块记住最后路由（含 search params，如收集箱 Tab/筛选/页码、知识库选中项），侧栏导航跳转到记住的路由；列表滚动位置按路由缓存恢复；查询数据由 TanStack Query 缓存。
- 整理进度：SSE `GET /v1/organize/events` 推送，侧栏显示进度。
- 开发：Vite dev server 代理 `/v1` 到 43118；生产：服务托管 `apps/workbench/dist`。

## 扩展工程

- 迁移到 WXT（S3）：MV3、TS、开发时 HMR（content script 自动重载），`wxt zip` 打包，跨 Chrome/Edge/Firefox。
- `collector-runtime` 作为依赖打包进 content script；service worker 内实现 01 的联通校验、IndexedDB（Dexie）、同步器；弹窗用 React 或原生 TS（弹窗简单，推荐原生 TS + 少量 CSS 减小体积）。
- 发布：开源版先「加载已解压扩展」，稳定后上架 Chrome Web Store（需隐私说明：数据只发往 127.0.0.1）。

## 交付

- 发布 npm 包 `study-studio`：`npx study-studio` 启动服务、打开工作台；`study-studio --data-dir --port`。
- 运行要求：Node ≥ 22.13（若 S4 选 `node:sqlite`）。启动时检测版本并给出提示。
- 首次启动引导：打开工作台 → 显示配对令牌与扩展安装步骤 → 扩展连接成功后进入首页。

## 测试

| 层 | 工具 | 覆盖 |
| --- | --- | --- |
| 服务 | `node:test`（现有）+ 内存 SQLite | 入库去重、阅读时长规则、批量同步逐条结果、删除级联与回收站回滚、整理增量判断、迁移 |
| 采集运行时 | Playwright + fixtures（现有） | 适配器、门槛、列表页判定 |
| 扩展 | Playwright 加载扩展（现有 `e2e-extension`） | 服务停止 → 采集入 IndexedDB → 启动服务 → 自动/手动同步 → 计数归零 |
| 前端 | Vitest + Testing Library；关键流程 Playwright | 收集箱选择逻辑、整理弹窗范围、删除预览、模块状态保留 |
| 整理 | 录制的 LLM 响应（fixture）回放 | 片段切分规则（纯函数单测）、规则预过滤、学习判定 / 知识处理分支与兜底阈值、对齐校验、补丁应用（含标题找不到的降级）、`user_edited` 保护、stale 重写 |

## 选型

### S3 扩展工程框架

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ WXT | 基于 Vite，HMR、自动 manifest、TS、多浏览器、打包上架工具齐全，社区活跃 | 需迁移现有 esbuild 构建脚本 |
| 保留 esbuild 自建（现状） | 无迁移成本 | 无热更新，每次需手动 build + 刷新扩展 |
| Plasmo | 约定式开发、React 友好 | 近年更新放缓，依赖 Parcel |
| CRXJS（Vite 插件） | 轻量、HMR | 只做构建，打包/多浏览器需自己补 |

### S20 UI 组件基础

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ Radix 原语 + 原型 CSS 变量（CSS Modules） | 原型样式直接迁移，视觉零偏差；可访问性由 Radix 保证 | 组件外观需自己写（原型已有） |
| shadcn/ui + Tailwind | 组件代码拷入仓库可改，生态大 | 需把原型样式改写成 Tailwind，迁移成本中等 |
| Ant Design | 组件最全（表格、树、表单） | 视觉体系强，难还原原型「简洁轻松」风格；体积大 |
| Mantine | 组件全、主题可定制 | 同样需覆盖大量默认样式 |

### S21 前端路由

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ TanStack Router | search params 类型安全（收集箱筛选/分页、知识库选中项放 URL，天然支持状态保留与刷新恢复）；与 TanStack Query 集成 | 学习成本略高 |
| React Router v7 | 最普及 | search params 无类型，需自行解析 |

### S22 服务常驻方式

扩展离线暂存解决了服务未启动时的数据丢失，常驻只影响「同步是否及时」。

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| ★ 默认手动 `npx study-studio`，设置中提供「开机自启」开关（生成 macOS launchd / Windows 计划任务 / Linux systemd user unit） | 无额外依赖，用户可选 | 三个平台各写一份配置生成逻辑 |
| pm2 | 跨平台守护、日志 | 额外全局依赖，开源用户需多装一步 |
| 仅手动 | 最简单 | 用户常忘记启动，数据长期滞留扩展 |
| 原生消息（Native Messaging）由扩展拉起服务 | 扩展可按需启动服务 | 需安装 host manifest，安装流程复杂；留作桌面端阶段方案 |
