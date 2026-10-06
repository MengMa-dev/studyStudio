import { installCollector } from "@study-studio/collector-runtime";
import { COLLECTING_KEY, readCollecting } from "../lib/collecting";

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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** On the logged-in workbench, fetch the pairing token so the user never copies it. Loopback only: any site can add the meta tag. */
async function autoPair(): Promise<void> {
  if (!LOOPBACK.has(location.hostname)) return;
  const response = await fetch("/v1/pairing/token", { credentials: "same-origin" }).catch(() => null);
  if (!response?.ok) return;
  const { ingestionUrl, pairingToken } = (await response.json()) as { ingestionUrl?: string; pairingToken?: string };
  if (!ingestionUrl || !pairingToken || !LOOPBACK.has(new URL(ingestionUrl).hostname)) return;
  const stored = await browser.storage.local.get(["ingestionUrl", "pairingToken"]);
  if (stored.ingestionUrl === ingestionUrl && stored.pairingToken === pairingToken) return;
  await browser.runtime.sendMessage({ type: "study-studio:save-connection", ingestionUrl, pairingToken }).catch(() => {});
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  async main() {
    if (document.querySelector('meta[name="study-studio-app"]')) return autoPair();
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

    let collecting = await readCollecting();
    let installing: Promise<Collector> | null = null;
    const start = async () => {
      if (collector) return collector;
      installing ??= install().finally(() => {
        installing = null;
      });
      const next = await installing;
      if (!collecting) {
        next.stop();
        return next;
      }
      collector = next;
      return next;
    };
    const stop = () => {
      collector?.stop();
      collector = null;
    };

    if (collecting) await start();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(COLLECTING_KEY in changes)) return;
      collecting = changes[COLLECTING_KEY]!.newValue === true;
      if (collecting) void start();
      else stop();
    });
    window.addEventListener("pagehide", () => {
      collector?.stop();
      collector = null;
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && collecting && !collector) void start();
    });

    browser.runtime.onMessage.addListener((message: { type?: string; text?: string }, _sender, respond) => {
      if (message.type !== "study-studio:add-note" || !message.text) return;
      if (!collecting) {
        respond({ ok: false, stopped: true });
        return;
      }
      void (async () => {
        collector ??= await start();
        collector.addNote(message.text!);
        respond({ ok: true, mode: collector.mode });
      })();
      return true;
    });
  }
});
