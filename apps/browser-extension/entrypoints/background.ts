const DEFAULTS = { ingestionUrl: "http://127.0.0.1:43118", pairingToken: "" };
const MAX_QUEUE = 500;
/* Navigation-only events never reach the timeline; dropping them keeps the offline queue for learning events. */
const UNSENT_EVENT_TYPES = new Set(["page_opened"]);

type CollectorEvent = { type?: string } & Record<string, unknown>;
type Message = { type?: string; event?: CollectorEvent; canonicalUrl?: string };

export default defineBackground(() => {
  const config = () => browser.storage.local.get(DEFAULTS) as Promise<typeof DEFAULTS>;

  async function request(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
    const { ingestionUrl, pairingToken } = await config();
    if (!pairingToken) throw new Error("未配置配对令牌");
    const response = await fetch(`${ingestionUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${pairingToken}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body: payload as Record<string, unknown> | null };
  }

  let queueLock: Promise<unknown> = Promise.resolve();
  function withQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queueLock.then(task, task);
    queueLock = run.catch(() => {});
    return run;
  }

  const pendingEvents = async () => ((await browser.storage.local.get("pendingEvents")).pendingEvents as CollectorEvent[] | undefined) ?? [];

  async function sendOrQueue(event: CollectorEvent | undefined) {
    if (!event || UNSENT_EVENT_TYPES.has(event.type ?? "")) return { ok: true, skipped: true };
    try {
      const result = await request("/v1/events", { method: "POST", body: event });
      if (result.status === 401 || result.status >= 500) throw new Error(`ingestion ${result.status}`);
      void flushQueue();
      return result;
    } catch (error) {
      await withQueue(async () => {
        const queue = await pendingEvents();
        queue.push(event);
        await browser.storage.local.set({ pendingEvents: queue.slice(-MAX_QUEUE) });
      });
      return { ok: false, queued: true, error: (error as Error).message };
    }
  }

  function flushQueue() {
    return withQueue(async () => {
      const queue = await pendingEvents();
      const remaining: CollectorEvent[] = [];
      for (const [index, event] of queue.entries()) {
        try {
          const result = await request("/v1/events", { method: "POST", body: event });
          if (result.status === 401 || result.status >= 500) throw new Error();
        } catch {
          remaining.push(...queue.slice(index));
          break;
        }
      }
      await browser.storage.local.set({ pendingEvents: remaining });
      return remaining.length;
    });
  }

  async function lookupPage(canonicalUrl = "") {
    try {
      const result = await request(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`);
      return { captured: result.body?.captured === true };
    } catch {
      return { captured: false };
    }
  }

  async function status() {
    const pending = (await pendingEvents()).length;
    try {
      const result = await request("/v1/pairing");
      if (result.ok) await flushQueue();
      return { paired: result.ok, status: result.status, pending: (await pendingEvents()).length };
    } catch (error) {
      return { paired: false, error: (error as Error).message, pending };
    }
  }

  const handlers: Record<string, (message: Message) => Promise<unknown>> = {
    "study-studio:event": (message) => sendOrQueue(message.event),
    "study-studio:lookup-page": (message) => lookupPage(message.canonicalUrl),
    "study-studio:status": () => status()
  };

  browser.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    const handler = handlers[message?.type ?? ""];
    if (!handler) return;
    handler(message).then(sendResponse, (error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  browser.runtime.onStartup.addListener(() => {
    void flushQueue();
  });

  /* Tabs opened before install/reload keep an orphaned content script that can no longer reach
     this worker, so inject a fresh copy instead of requiring a manual page refresh. */
  browser.runtime.onInstalled.addListener(async () => {
    const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined ? null : browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["/content-scripts/content.js"] }).catch(() => {})
      )
    );
  });
});
