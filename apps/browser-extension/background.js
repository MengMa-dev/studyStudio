const DEFAULTS = { ingestionUrl: "http://127.0.0.1:43118", pairingToken: "" };
const MAX_QUEUE = 500;
/* Navigation-only events never reach the timeline; dropping them keeps the offline queue for learning events. */
const UNSENT_EVENT_TYPES = new Set(["page_opened"]);

async function config() {
  return chrome.storage.local.get(DEFAULTS);
}

async function request(path, { method = "GET", body } = {}) {
  const { ingestionUrl, pairingToken } = await config();
  if (!pairingToken) throw new Error("未配置配对令牌");
  const response = await fetch(`${ingestionUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${pairingToken}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body: payload };
}

let queueLock = Promise.resolve();
function withQueue(task) {
  const run = queueLock.then(task, task);
  queueLock = run.catch(() => {});
  return run;
}

async function sendOrQueue(event) {
  if (UNSENT_EVENT_TYPES.has(event?.type)) return { ok: true, skipped: true };
  try {
    const result = await request("/v1/events", { method: "POST", body: event });
    if (result.status === 401 || result.status >= 500) throw new Error(`ingestion ${result.status}`);
    flushQueue();
    return result;
  } catch (error) {
    await withQueue(async () => {
      const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");
      pendingEvents.push(event);
      await chrome.storage.local.set({ pendingEvents: pendingEvents.slice(-MAX_QUEUE) });
    });
    return { ok: false, queued: true, error: error.message };
  }
}

function flushQueue() {
  return withQueue(async () => {
    const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");
    const remaining = [];
    for (const [index, event] of pendingEvents.entries()) {
      try {
        const result = await request("/v1/events", { method: "POST", body: event });
        if (result.status === 401 || result.status >= 500) throw new Error();
      } catch {
        remaining.push(...pendingEvents.slice(index));
        break;
      }
    }
    await chrome.storage.local.set({ pendingEvents: remaining });
    return remaining.length;
  });
}

async function lookupPage(canonicalUrl) {
  try {
    const result = await request(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`);
    return { captured: result.body?.captured === true };
  } catch {
    return { captured: false };
  }
}

async function status() {
  const { pendingEvents = [] } = await chrome.storage.local.get("pendingEvents");
  try {
    const result = await request("/v1/pairing");
    if (result.ok) await flushQueue();
    const { pendingEvents: left = [] } = await chrome.storage.local.get("pendingEvents");
    return { paired: result.ok, status: result.status, pending: left.length };
  } catch (error) {
    return { paired: false, error: error.message, pending: pendingEvents.length };
  }
}

const handlers = {
  "study-studio:event": (message) => sendOrQueue(message.event),
  "study-studio:lookup-page": (message) => lookupPage(message.canonicalUrl),
  "study-studio:status": () => status()
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return;
  handler(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onStartup.addListener(() => { flushQueue(); });

/* Tabs opened before install/reload keep an orphaned content script that can no longer reach
   this worker, so inject a fresh copy instead of requiring a manual page refresh. */
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["runtime.js", "content.js"]
  }).catch(() => {})));
});
