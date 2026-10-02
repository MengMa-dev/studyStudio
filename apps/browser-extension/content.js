(() => {
  const runtime = globalThis.StudyStudioCollector;
  if (!runtime || globalThis.__studyStudioInstalled) return;
  globalThis.__studyStudioInstalled = true;

  let collector = null;
  const emit = (event) => {
    try {
      chrome.runtime.sendMessage({ type: "study-studio:event", event }).catch(() => {});
    } catch {
      // The extension was reloaded; this orphaned content script must stop collecting.
      collector?.stop();
      collector = null;
    }
  };
  const pageIndex = {
    lookup: async (canonicalUrl) => (await chrome.runtime.sendMessage({ type: "study-studio:lookup-page", canonicalUrl })) ?? { captured: false }
  };
  const install = () => runtime.installCollector({ emit, channel: "browser_extension", isStrongLearning: false, pageIndex });

  collector = install();
  window.addEventListener("pagehide", () => { collector?.stop(); collector = null; });
  window.addEventListener("pageshow", (event) => { if (event.persisted && !collector) collector = install(); });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== "study-studio:add-note") return;
    if (!collector) collector = install();
    collector.addNote(message.text);
    respond({ ok: true, mode: collector.mode });
  });
})();
