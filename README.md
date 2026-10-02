# Study Studio

本仓库实现本地优先的学习内容采集最小链路：浏览器扩展或桌面内置浏览器中的采集器发出标准事件，本地接收服务把时间线和原始内容写入本地目录。方案见 `docs/collection-plan.md`。

## 运行

```bash
npm install
npm run ingestion
```

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

## 测试

```bash
npm test
```

包含本地服务测试和基于 Playwright 的 fixture 回归测试（使用本机 Google Chrome，可用 `STUDY_STUDIO_CHROME_CHANNEL` 指定其他 channel；未安装时浏览器测试自动跳过）。

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
- `packages/collector-contract`：事件类型与校验。
- `services/local-ingestion`：本地接收服务（校验、按 canonical URL 去重、时间线、inbox、阅读时长累加）。
- `apps/browser-extension`、`apps/desktop`：两个宿主的最小桥接。
