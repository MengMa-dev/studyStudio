import { installCollector } from "@study-studio/collector-runtime";

type Collector = ReturnType<typeof installCollector>;

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    const flags = globalThis as { __studyStudioInstalled?: boolean };
    if (flags.__studyStudioInstalled) return;
    flags.__studyStudioInstalled = true;

    let collector: Collector | null = null;
    const emit = (event: unknown) => {
      try {
        browser.runtime.sendMessage({ type: "study-studio:event", event }).catch(() => {});
      } catch {
        // The extension was reloaded; this orphaned content script must stop collecting.
        collector?.stop();
        collector = null;
      }
    };
    const pageIndex = {
      lookup: async (canonicalUrl: string) => (await browser.runtime.sendMessage({ type: "study-studio:lookup-page", canonicalUrl })) ?? { captured: false }
    };
    const install = () => installCollector({ emit, channel: "browser_extension", isStrongLearning: false, pageIndex });

    collector = install();
    window.addEventListener("pagehide", () => {
      collector?.stop();
      collector = null;
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !collector) collector = install();
    });

    browser.runtime.onMessage.addListener((message: { type?: string; text?: string }, _sender, respond) => {
      if (message.type !== "study-studio:add-note" || !message.text) return;
      collector ??= install();
      collector.addNote(message.text);
      respond({ ok: true, mode: collector.mode });
    });
  }
});
