import { DEFAULT_CAPTURE_RULES, type CollectorSettings } from "@study-studio/shared";
import { loadCachedSettings, readConnection, refreshSettings, writeConnection, apiRequest, FALLBACK_SETTINGS } from "../lib/api";
import { checkConnectivity, getConnectivity, restoreConnectivity } from "../lib/connectivity";
import { clearFailed, listFailed, pendingCounts, wasCapturedLocally, type CollectorEvent } from "../lib/db";
import { detectSearch, isAiConversationUrl, mapTransition, matchesExclusion, resolveCategory, type TabNavState } from "../lib/rules";
import { getSyncProgress, ingestEvent, syncPending, updateBadge } from "../lib/sync";

const ALARM_CONNECTIVITY = "study-studio-connectivity";
const ALARM_SETTINGS = "study-studio-settings";

const tabNav = new Map<number, TabNavState>();
const recentAiAt: number[] = [];
let settingsCache: CollectorSettings = FALLBACK_SETTINGS;

type Message = {
  type?: string;
  event?: CollectorEvent;
  canonicalUrl?: string;
  presence?: Record<string, unknown>;
  url?: string;
  ingestionUrl?: string;
  pairingToken?: string;
};

function rememberAi(ts = Date.now()) {
  recentAiAt.push(ts);
  while (recentAiAt.length && ts - recentAiAt[0]! > 60 * 60_000) recentAiAt.shift();
}

function nearAiConversation(windowMinutes: number): boolean {
  if (windowMinutes <= 0) return false;
  const windowMs = windowMinutes * 60_000;
  const now = Date.now();
  return recentAiAt.some((ts) => Math.abs(now - ts) <= windowMs);
}

async function refreshAlarmSchedule() {
  const { total } = await pendingCounts();
  await browser.alarms.create(ALARM_CONNECTIVITY, { periodInMinutes: total > 0 ? 1 : 5 });
  await browser.alarms.create(ALARM_SETTINGS, { periodInMinutes: 5 });
}

async function bootstrapStatus() {
  await restoreConnectivity();
  settingsCache = await loadCachedSettings();
  const previous = getConnectivity().state;
  const connectivity = await checkConnectivity();
  settingsCache = await refreshSettings().catch(() => settingsCache);
  if (connectivity.state === "online" && previous !== "online") await syncPending("auto");
  else if (connectivity.state === "online") await syncPending("startup");
  await updateBadge();
  await refreshAlarmSchedule();
}

function navForTab(tabId?: number) {
  return tabId === undefined ? undefined : tabNav.get(tabId);
}

async function handleEvent(event: CollectorEvent | undefined, senderTabId?: number) {
  if (!event) return { ok: true, skipped: true };
  if (event.type === "user_message_sent" || event.type === "assistant_response_completed") rememberAi();
  const nav = navForTab(senderTabId);
  return ingestEvent(event, nav);
}

async function lookupPage(canonicalUrl = "") {
  if (!canonicalUrl) return { captured: false };
  if (await wasCapturedLocally(canonicalUrl)) return { captured: true };
  try {
    const result = await apiRequest<{ captured?: boolean }>(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`);
    if (result.ok && result.body?.captured) return { captured: true };
  } catch {
    // offline lookup falls through to local cache only
  }
  return { captured: false };
}

async function statusPayload() {
  const connectivity = getConnectivity();
  const counts = await pendingCounts();
  const failed = await listFailed();
  const connection = await readConnection();
  return {
    connectivity,
    counts,
    failedCount: failed.length,
    sync: getSyncProgress(),
    connection,
    settings: settingsCache
  };
}

async function isStudioOrigin(href: string) {
  try {
    return new URL(href).origin === new URL((await readConnection()).ingestionUrl).origin;
  } catch {
    return false;
  }
}

async function bootstrapForTab(tabId?: number, url?: string) {
  settingsCache = await loadCachedSettings();
  const href = url ?? "";
  const excluded = href
    ? (await isStudioOrigin(href)) || matchesExclusion(href, settingsCache.exclusionRules, settingsCache.builtinListPageRules)
    : false;
  const category = href ? resolveCategory(href, settingsCache) : "neutral";
  const nav = navForTab(tabId);
  const captureRules = settingsCache.captureRules ?? DEFAULT_CAPTURE_RULES;
  const fromSearch = Boolean(nav?.fromSearch) && captureRules.captureFromSearch;
  const nearAi = nearAiConversation(captureRules.aiConversationWindowMinutes);
  if (href && isAiConversationUrl(href)) rememberAi();
  return {
    settings: settingsCache,
    excluded,
    category,
    tabId,
    navigation: nav
      ? {
          openerTabId: nav.openerTabId,
          referrer: nav.referrer,
          transition: nav.transition
        }
      : null,
    captureHints: { fromSearch, nearAiConversation: nearAi },
    threshold: {
      minActiveSeconds: captureRules.minActiveSeconds,
      minScrollDepth: captureRules.minScrollDepth,
      minRevisitSeconds: captureRules.minRevisitSeconds
    },
    activityEnabled: settingsCache.activityTracking.enabled,
    conversationPlatforms: settingsCache.conversationPlatforms
  };
}

export default defineBackground(() => {
  void bootstrapStatus();

  browser.runtime.onStartup.addListener(() => {
    void bootstrapStatus();
  });
  browser.runtime.onInstalled.addListener(async () => {
    await bootstrapStatus();
    const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined ? null : browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["/content-scripts/content.js"] }).catch(() => {})
      )
    );
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_CONNECTIVITY) {
      void (async () => {
        const previous = getConnectivity().state;
        const next = await checkConnectivity();
        if (next.state === "online" && previous !== "online") await syncPending("auto");
        await updateBadge();
        await refreshAlarmSchedule();
      })();
    }
    if (alarm.name === ALARM_SETTINGS) {
      void refreshSettings()
        .then((settings) => {
          settingsCache = settings;
        })
        .catch(() => {});
    }
  });

  browser.idle.setDetectionInterval(60);
  browser.idle.onStateChanged.addListener((state) => {
    if (!settingsCache.activityTracking.enabled) return;
    const mapped = state === "active" ? "active" : "idle";
    void ingestEvent({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      type: "activity_state",
      occurredAt: new Date().toISOString(),
      source: { channel: "browser_extension" },
      state: mapped
    });
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    if (!settingsCache.activityTracking.enabled) return;
    const state = windowId === browser.windows.WINDOW_ID_NONE ? "blur" : "focus";
    void ingestEvent({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      type: "activity_state",
      occurredAt: new Date().toISOString(),
      source: { channel: "browser_extension" },
      state
    });
  });

  browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const current = tabNav.get(details.tabId) ?? { tabId: details.tabId };
    current.openerTabId = details.sourceTabId;
    const source = tabNav.get(details.sourceTabId);
    if (source?.url && detectSearch(source.url)) current.fromSearch = true;
    tabNav.set(details.tabId, current);
  });

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const current = tabNav.get(details.tabId) ?? { tabId: details.tabId };
    current.transition = mapTransition(details.transitionType);
    current.url = details.url;
    if (detectSearch(details.url)) current.fromSearch = true;
    if (isAiConversationUrl(details.url)) rememberAi();
    tabNav.set(details.tabId, current);
  });

  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined) return;
    const current = tabNav.get(tab.id) ?? { tabId: tab.id };
    if (tab.openerTabId !== undefined) {
      current.openerTabId = tab.openerTabId;
      const opener = tabNav.get(tab.openerTabId);
      if (opener?.url && detectSearch(opener.url)) current.fromSearch = true;
    }
    tabNav.set(tab.id, current);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabNav.delete(tabId);
  });

  const handlers: Record<string, (message: Message, sender: { tab?: { id?: number; url?: string } }) => Promise<unknown>> = {
    "study-studio:event": (message, sender) => handleEvent(message.event, sender.tab?.id),
    "study-studio:lookup-page": (message) => lookupPage(message.canonicalUrl),
    "study-studio:status": async () => {
      await checkConnectivity();
      settingsCache = await refreshSettings().catch(() => settingsCache);
      if (getConnectivity().state === "online") void syncPending("popup");
      return statusPayload();
    },
    "study-studio:sync": async () => {
      const connectivity = await checkConnectivity();
      if (connectivity.state !== "online") return { ok: false, ...(await statusPayload()) };
      const result = await syncPending("manual");
      return { ok: true, ...result, ...(await statusPayload()) };
    },
    "study-studio:bootstrap": (_message, sender) => bootstrapForTab(sender.tab?.id, sender.tab?.url),
    "study-studio:get-settings": async () => {
      settingsCache = await loadCachedSettings();
      return settingsCache;
    },
    "study-studio:presence": async (message) => {
      if (getConnectivity().state !== "online") return { ok: false, dropped: true };
      const result = await apiRequest("/v1/presence", { method: "POST", body: message.presence, timeoutMs: 2_000 });
      return { ok: result.ok };
    },
    "study-studio:search": async (message, sender) => {
      if (!message.url || !settingsCache.activityTracking.enabled) return { ok: true };
      const parsed = detectSearch(message.url);
      if (!parsed) return { ok: true };
      return handleEvent(
        {
          id: crypto.randomUUID(),
          schemaVersion: 1,
          type: "search_performed",
          occurredAt: new Date().toISOString(),
          source: { channel: "browser_extension", url: message.url },
          search: { engine: parsed.engine, query: parsed.query, tabId: sender.tab?.id }
        },
        sender.tab?.id
      );
    },
    "study-studio:failed-list": async () => listFailed(),
    "study-studio:failed-clear": async () => {
      await clearFailed();
      return { ok: true };
    },
    "study-studio:save-connection": async (message) => {
      await writeConnection({
        ingestionUrl: message.ingestionUrl ?? "http://127.0.0.1:43118",
        pairingToken: message.pairingToken ?? ""
      });
      await checkConnectivity();
      settingsCache = await refreshSettings().catch(() => settingsCache);
      if (getConnectivity().state === "online") await syncPending("auto");
      await updateBadge();
      return statusPayload();
    }
  };

  browser.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
    const handler = handlers[message?.type ?? ""];
    if (!handler) return;
    handler(message, sender).then(sendResponse, (error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  // Test / Playwright hooks: call from the service worker context (sendMessage to self is invalid).
  Object.assign(globalThis as { __studyStudio?: unknown }, {
    __studyStudio: {
      status: () => statusPayload(),
      sync: async () => {
        const connectivity = await checkConnectivity();
        if (connectivity.state !== "online") return { ok: false, ...(await statusPayload()) };
        const result = await syncPending("manual");
        return { ok: true, ...result, ...(await statusPayload()) };
      },
      saveConnection: (ingestionUrl: string, pairingToken: string) =>
        handlers["study-studio:save-connection"]!({ type: "study-studio:save-connection", ingestionUrl, pairingToken }, {}),
      failedList: () => listFailed(),
      failedClear: () => clearFailed(),
      ingest: (event: CollectorEvent) => handleEvent(event),
      checkConnectivity,
      refreshSettings: async () => {
        settingsCache = await refreshSettings();
        return settingsCache;
      }
    }
  });
});
