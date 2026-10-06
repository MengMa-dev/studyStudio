# Study Studio

本仓库实现本地优先的学习内容采集最小链路：浏览器扩展或桌面内置浏览器中的采集器发出标准事件，本地接收服务把时间线和原始内容写入本地目录。方案见 `docs/collection-plan.md`。

## 让 Agent 一句话安装

在 Cursor / Claude Code / Codex 中发送：

> 安装 https://github.com/MengMa-dev/studyStudio 的 skills

Agent 会按 [`skills/INSTALL.md`](skills/INSTALL.md) 先征得确认，然后克隆并启动本地服务，再安装 `organize-kb` skill 与 `study-studio` MCP。手动安装同理：服务运行后执行 `npm start -- agent install --target cursor`（或 `study-studio agent install`）。

## 安装与使用（发布版）

要求 Node.js ≥ 22.13（23.x 需 ≥ 23.5），本地数据库使用内置 `node:sqlite`；版本不满足时 CLI 会提示并退出。

```bash
npx study-studio                    # 启动服务并在浏览器打开工作台
npx study-studio --data-dir ~/Notes/StudyStudioData --port 43119 --no-open
npx study-studio --help
```

- 数据目录默认 `~/StudyStudioData`（`--data-dir` > `STUDY_STUDIO_DATA_DIR` > 默认）；端口默认 `43118`（`--port` > `STUDY_STUDIO_PORT`）。
- 启动后自动打开工作台并登录，浏览器会长期保持登录（服务重启不失效）；换浏览器或登录失效时运行 `study-studio open`。服务已在运行时再次执行 `study-studio` 等价于 `open`。
- `sqlite-vec` 无当前平台预编译二进制时自动关闭向量检索（终端有提示），其余功能不受影响。
- 开机自启（默认关闭）：先 `npm i -g study-studio`，再 `study-studio autostart enable`（macOS launchd / Linux systemd 用户服务 / Windows 计划任务）；`autostart status`、`autostart disable` 查看与关闭。

### 安装浏览器扩展

1. 从发布页下载 `study-studio-extension-<版本>-chrome.zip` 并解压（或自行运行 `npm run pack:extension`，产物在 `apps/browser-extension/.output/`）。
2. Chrome 打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」选择解压后的目录。
3. 打开一次工作台，扩展自动完成配对（弹窗显示已连接）。也可在弹窗中手动填写终端打印的配对令牌。

## 开发

```bash
npm install
npm run dev        # 本地服务（tsx watch，:43118）+ 工作台 Vite dev server（真实 API，:5173/app/），Ctrl+C 一起退出
npm run ingestion  # 只启动本地服务
```

`npm run dev` 与 `npm run ingestion` 的数据目录默认为仓库内 `./StudyStudioData`。工作台单独以 mock 数据开发：`npm run dev -w @study-studio/workbench`。

## 构建与发布

```bash
npm run build          # shared 类型检查 → 工作台 vite build → study-studio 包（tsup）
npm start              # 运行构建好的包（等价于 npx study-studio）
npm run build:release  # build + 扩展 wxt zip + npm pack，产物汇总到 release/
npm run pack:extension # 只打包扩展 zip
```

发布的 npm 包源码在 `packages/cli`（包名 `study-studio`，仓库根包为私有的 `study-studio-monorepo`）：`bin/study-studio.js` 先检测 Node 版本再加载 `dist/server/cli.js`（tsup 打包本地服务及其依赖，仅 `sqlite-vec` 作为运行时依赖安装），`dist/migrations/` 为 SQL 迁移，`dist/workbench/` 为工作台静态文件（服务托管于 `/app`）。发布：`npm run build` 后 `npm publish -w study-studio`。

## 旧版演示

服务默认监听 `127.0.0.1:43118`，首次启动会在终端显示配对令牌。另开终端运行：

```bash
STUDY_STUDIO_TOKEN=<令牌> npm run demo
```

开发环境 AI 配置：`npm run setup:ai` 读取仓库上级目录的 `.api.txt`（或 `STUDY_STUDIO_KEYS_FILE`），把 key 写入 `StudyStudioData/secrets.json`（不进仓库）并验证各服务商，模型选择见 `docs/tech-solution/06-ai-gateway.md`。

演示会模拟“用户提问 → AI 回答完成”和“网页达到学习门槛”，并将结果写入 `./StudyStudioData`。可用 `STUDY_STUDIO_TOKEN`、`STUDY_STUDIO_DATA_DIR` 和 `STUDY_STUDIO_PORT` 覆盖默认配置。

调试时可用 `STUDY_STUDIO_DEV=1` 降低门槛：页面可见 5 秒即入箱（不要求滚动），已入箱页面再次停留 3 秒即累加时长。需同时作用于构建和服务：`STUDY_STUDIO_DEV=1 npm run build:extension` 后重新加载扩展，并用 `STUDY_STUDIO_DEV=1 npm run ingestion` 启动服务。

## 浏览器扩展

```bash
npm run build:extension
```

构建后在 Chrome 中“加载已解压的扩展程序”，选择 `apps/browser-extension`，在弹窗中填入配对令牌。弹窗会显示连接状态；本地服务不可用时事件暂存在扩展中，恢复连接后自动重发。

WXT 版扩展（M2 起替代上面的 esbuild 构建）：`npm run build -w @study-studio/browser-extension`，产物在 `apps/browser-extension/.output/chrome-mv3`；`npm run dev -w @study-studio/browser-extension` 启动热更新开发。

## 检查与测试

```bash
npm run check   # 类型检查（各 workspace）+ ESLint + Prettier
npm test        # node:test（经 tsx 运行 TS）
```

包含 schema 单测、SQLite 能力测试、本地服务测试和基于 Playwright 的 fixture 回归测试（使用本机 Google Chrome，可用 `STUDY_STUDIO_CHROME_CHANNEL` 指定其他 channel；未安装时浏览器测试自动跳过）。

### 技术验证（M0）

```bash
npm run verify:sqlite   # node:sqlite + FTS5（unicode61 / trigram）+ sqlite-vec
npm run verify:ai       # generateObject + Zod discriminated union，按 ai-seed.json 逐个模型实测；--only=mock,ollama 只跑本地，--full 云端也跑全部样例
npm run verify:wxt      # WXT 构建扩展，加载后采集 fixtures 并经后台送达本地服务
```

### 真实网站验证

真实网站脚本使用 Playwright 自带的 Chromium（`npx playwright-core install chromium`），默认无头后台运行，加 `--headed` 显示窗口。浏览器 profile 固定在 `.browser-profile/`，登录状态会保留：

```bash
npm run browser:login -- https://chat.deepseek.com/      # 首次：在弹出的窗口中登录，完成后关闭窗口
npm run e2e:extension -- https://chat.deepseek.com/ "一句话解释向量召回"   # 加载真实扩展端到端验证，需先运行 npm run ingestion
node scripts/debug-live-chat.js https://chat.deepseek.com/ "问题"       # 只注入运行时，打印适配器识别结果
```

`.browser-profile/` 中保存了登录 cookie，已加入 `.gitignore`，不要提交或分享。

## 目录

- `packages/collector-runtime`：宿主无关的采集运行时（门槛判定、网页提取级联、站点/对话适配器、SPA 导航）。
- `packages/collector-contract`：事件构造与校验（基于 `packages/shared` 的 schema）。
- `packages/shared`：前后端与扩展共用的 Zod schema（事件、设置）与域名规则。
- `packages/cli`：发布用 npm 包 `study-studio`（CLI、Node 版本检测、开机自启、tsup 打包配置）。
- `services/local-ingestion`：本地接收服务（校验、按 canonical URL 去重、时间线、inbox、阅读时长累加）。
- `apps/browser-extension`、`apps/desktop`：两个宿主的最小桥接。
