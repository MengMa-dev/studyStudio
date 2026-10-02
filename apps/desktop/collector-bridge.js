import { installCollector } from "../../packages/collector-runtime/src/browser-collector.js";

/**
 * Call this inside a desktop WebView/WebContents page once its document is available
 * (e.g. from a preload script). The host owns transport; this bridge stays independent of Electron/Tauri.
 */
export function installDesktopCollector({ window, document, sendEvent, lookupPage = null }) {
  return installCollector({
    emit: sendEvent,
    channel: "desktop_browser",
    isStrongLearning: true,
    pageIndex: lookupPage ? { lookup: lookupPage } : null,
    doc: document,
    win: window
  });
}
