import { installDesktopCollector } from "./collector-bridge.js";

/**
 * Bundled into dist/collector-inject.js and executed in every page of the built-in browser.
 * The host exposes `window.StudyStudioHost = { sendEvent(event), lookupPage?(canonicalUrl) }`
 * (Electron: contextBridge in preload; Tauri: initialization script + invoke).
 */
(() => {
  const host = globalThis.StudyStudioHost;
  if (!host?.sendEvent || globalThis.__studyStudioInstalled) return;
  globalThis.__studyStudioInstalled = true;
  const install = () => installDesktopCollector({
    window,
    document,
    sendEvent: (event) => Promise.resolve(host.sendEvent(event)).catch(() => {}),
    lookupPage: host.lookupPage ? (canonicalUrl) => host.lookupPage(canonicalUrl) : null
  });
  let collector = install();
  globalThis.StudyStudioCollectorInstance = {
    addNote: (text) => collector?.addNote(text),
    get mode() { return collector?.mode ?? null; }
  };
  window.addEventListener("pagehide", () => { collector?.stop(); collector = null; });
  window.addEventListener("pageshow", (event) => { if (event.persisted && !collector) collector = install(); });
})();
