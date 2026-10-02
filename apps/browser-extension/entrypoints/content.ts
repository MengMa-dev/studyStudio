import { installCollector } from "@study-studio/collector-runtime";

type Collector = ReturnType<typeof installCollector>;

type Bootstrap = {
  settings: {
    captureRules: { minActiveSeconds: number; minScrollDepth: number; minRevisitSeconds: number };
    activityTracking: { enabled: boolean };
    conversationPlatforms: Record<string, boolean>;
  };
  excluded: boolean;
  category: "learning_candidate" | "unrelated" | "neutral";
  tabId?: number;
  navigation: { openerTabId?: number; referrer?: string; transition?: "link" | "typed" | "back_forward" | "reload" | "other" } | null;
  captureHints: { fromSearch?: boolean; nearAiConversation?: boolean };
  threshold: { minActiveSeconds: number; minScrollDepth: number; minRevisitSeconds: number };
  activityEnabled: boolean;
  conversationPlatforms: Record<string, boolean>;
};

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  async main() {
    const flags = globalThis as { __studyStudioInstalled?: boolean };
    if (flags.__studyStudioInstalled) return;
    flags.__studyStudioInstalled = true;

    let collector: Collector | null = null;
    const emit = (event: unknown) => {
      try {
        browser.runtime.sendMessage({ type: "study-studio:event", event }).catch(() => {});
      } catch {
        collector?.stop();
        collector = null;
      }
    };
    const pageIndex = {
      lookup: async (canonicalUrl: string) => (await browser.runtime.sendMessage({ type: "study-studio:lookup-page", canonicalUrl })) ?? { captured: false }
    };

    const install = async () => {
      const bootstrap = (await browser.runtime.sendMessage({ type: "study-studio:bootstrap" }).catch(() => null)) as Bootstrap | null;
      if (!bootstrap) {
        return installCollector({ emit, channel: "browser_extension", pageIndex });
      }
      if (bootstrap.excluded) {
        return installCollector({
          emit,
          channel: "browser_extension",
          pageIndex,
          excluded: true
        });
      }
      return installCollector({
        emit,
        channel: "browser_extension",
        pageIndex,
        threshold: bootstrap.threshold,
        activityEnabled: bootstrap.activityEnabled,
        category: bootstrap.category,
        tabId: bootstrap.tabId ?? null,
        navigation: bootstrap.navigation,
        captureHints: bootstrap.captureHints,
        conversationPlatforms: bootstrap.conversationPlatforms,
        onPresence: (presence) => {
          browser.runtime.sendMessage({ type: "study-studio:presence", presence }).catch(() => {});
        },
        onSearch: (url) => {
          browser.runtime.sendMessage({ type: "study-studio:search", url }).catch(() => {});
        }
      });
    };

    collector = await install();
    window.addEventListener("pagehide", () => {
      collector?.stop();
      collector = null;
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !collector)
        void install().then((next) => {
          collector = next;
        });
    });

    browser.runtime.onMessage.addListener((message: { type?: string; text?: string }, _sender, respond) => {
      if (message.type !== "study-studio:add-note" || !message.text) return;
      void (async () => {
        collector ??= await install();
        collector.addNote(message.text!);
        respond({ ok: true, mode: collector.mode });
      })();
      return true;
    });
  }
});
