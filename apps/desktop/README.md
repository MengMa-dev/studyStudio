# Desktop collector bridge

桌面端与浏览器扩展使用同一 `collector-runtime`；区别仅为桌面端会在事件上标记 `isStrongLearning: true`。该标记只供未来整理评分使用，网页正文仍必须达到统一学习门槛才入箱。

## 接入方式

1. `npm run build:extension` 会同时生成 `apps/desktop/dist/collector-inject.js`。
2. 宿主在内置浏览器页面中暴露 `window.StudyStudioHost = { sendEvent(event), recordVisit(canonicalUrl) }`：
   - Electron：在 preload 中用 `contextBridge.exposeInMainWorld("StudyStudioHost", …)`，通过 IPC 转给主进程；
   - Tauri：用 initialization script 定义该对象并通过 `invoke` 转给 Rust/Node 侧。
3. 每次导航完成后执行 `collector-inject.js`（Electron：`webContents.executeJavaScript`；Tauri：initialization script）。脚本自带重复注入保护，并处理 SPA 路由切换。
4. 主进程使用 `createLocalIngestionClient({ pairingToken })` 返回的 `sendEvent` / `recordVisit` 转发到本地服务。

页面内可调用 `window.StudyStudioCollectorInstance.addNote(text)` 记录备注。若宿主能直接拿到页面的 `window`/`document`（例如在 preload 中打包），也可直接调用 `installDesktopCollector`。
