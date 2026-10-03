import {
  ACTIVITY_EVENT_TYPES,
  KNOWLEDGE_EVENT_TYPES,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  RECORD_EVENT_TYPES,
  eventBatchResultSchema
} from "@study-studio/shared";
import { apiRequest } from "./api";
import { checkConnectivity, getConnectivity, markOffline, markUnauthorized, shouldEnqueueWithoutSend } from "./connectivity";
import { db, enqueueEvent, pendingCounts, rememberCapturedUrl, type CollectorEvent } from "./db";

const IGNORED = new Set(["page_opened", "source_excluded"]);
const KNOWLEDGE = new Set<string>(KNOWLEDGE_EVENT_TYPES);
const RECORD = new Set<string>(RECORD_EVENT_TYPES);
const ACTIVITY = new Set<string>(ACTIVITY_EVENT_TYPES);

export type SyncProgress = { done: number; total: number; running: boolean };

let lastProgress: SyncProgress = { done: 0, total: 0, running: false };
const progressListeners = new Set<(progress: SyncProgress) => void>();

export function onSyncProgress(listener: (progress: SyncProgress) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function publishProgress(progress: SyncProgress) {
  lastProgress = progress;
  for (const listener of progressListeners) listener(progress);
  browser.runtime.sendMessage({ type: "study-studio:sync-progress", progress }).catch(() => {});
}

export function getSyncProgress(): SyncProgress {
  return lastProgress;
}

export async function updateBadge(): Promise<void> {
  const { knowledge } = await pendingCounts();
  const connectivity = getConnectivity();
  const text = knowledge > 0 ? String(Math.min(knowledge, 999)) : "";
  await browser.action.setBadgeText({ text });
  const color = connectivity.state === "unauthorized" ? "#c2410c" : connectivity.state === "offline" ? "#6b7280" : "#2563eb";
  await browser.action.setBadgeBackgroundColor({ color });
}

function enrichPageSession(event: CollectorEvent, navigation: NavigationHit | undefined): CollectorEvent {
  if (event.type !== "page_session" || !navigation) return event;
  const session = { ...(event.session as Record<string, unknown>) };
  if (navigation.openerTabId !== undefined) session.openerTabId = navigation.openerTabId;
  if (navigation.transition) session.transition = navigation.transition;
  if (navigation.referrer && session.referrer === undefined && session.category !== "unrelated") session.referrer = navigation.referrer;
  if (navigation.tabId !== undefined) session.tabId = navigation.tabId;
  return { ...event, session };
}

export type NavigationHit = {
  tabId?: number;
  openerTabId?: number;
  referrer?: string;
  transition?: string;
};

export async function ingestEvent(
  event: CollectorEvent | undefined,
  navigation?: NavigationHit
): Promise<{ ok: boolean; queued?: boolean; skipped?: boolean }> {
  if (!event || IGNORED.has(event.type)) return { ok: true, skipped: true };
  const enriched = enrichPageSession(event, navigation);
  if (enriched.type === "webpage_captured") {
    const canonicalUrl =
      (enriched.content as { canonicalUrl?: string } | undefined)?.canonicalUrl ?? (enriched.source as { canonicalUrl?: string } | undefined)?.canonicalUrl;
    if (canonicalUrl) await rememberCapturedUrl(canonicalUrl);
  }

  if (shouldEnqueueWithoutSend()) {
    await enqueueEvent(enriched);
    await updateBadge();
    return { ok: false, queued: true };
  }

  try {
    const result = await apiRequest("/v1/events", { method: "POST", body: enriched, timeoutMs: 3_000 });
    if (result.status === 401) {
      await markUnauthorized();
      await enqueueEvent(enriched);
      await updateBadge();
      return { ok: false, queued: true };
    }
    if (result.status === 422) {
      await db.failed_events.put({
        eventId: enriched.id,
        event: enriched,
        error: (result.body as { error?: string } | null)?.error ?? "rejected",
        failedAt: new Date().toISOString()
      });
      await updateBadge();
      return { ok: false };
    }
    if (!result.ok || result.status >= 500 || result.status === 0) {
      await markOffline(result.error ?? `HTTP ${result.status}`);
      await enqueueEvent(enriched);
      await updateBadge();
      return { ok: false, queued: true };
    }
    await updateBadge();
    return { ok: true };
  } catch (error) {
    await markOffline((error as Error).message);
    await enqueueEvent(enriched);
    await updateBadge();
    return { ok: false, queued: true };
  }
}

function batchBytes(events: CollectorEvent[]): number {
  return new TextEncoder().encode(JSON.stringify({ events })).length;
}

async function takeBatch(): Promise<{ seqs: number[]; events: CollectorEvent[] }> {
  const rows = await db.pending_events.orderBy("seq").toArray();
  const events: CollectorEvent[] = [];
  const seqs: number[] = [];
  for (const row of rows) {
    if (events.length >= MAX_BATCH_EVENTS) break;
    const next = [...events, row.event];
    if (batchBytes(next) > MAX_BATCH_BYTES && events.length > 0) break;
    events.push(row.event);
    seqs.push(row.seq!);
  }
  return { seqs, events };
}

export async function syncPending(reason = "auto"): Promise<{ synced: number; failed: number; remaining: number }> {
  const run = async () => {
    if (getConnectivity().state !== "online") {
      const connectivity = await checkConnectivity();
      if (connectivity.state !== "online") return { synced: 0, failed: 0, remaining: (await pendingCounts()).total };
    }

    let synced = 0;
    let failed = 0;
    const initial = await pendingCounts();
    if (initial.total === 0) {
      if (reason === "manual") browser.runtime.sendMessage({ type: "study-studio:sync-done", synced: 0, knowledge: 0 }).catch(() => {});
      return { synced: 0, failed: 0, remaining: 0 };
    }
    publishProgress({ done: 0, total: initial.total, running: true });

    while (true) {
      const { seqs, events } = await takeBatch();
      if (!events.length) break;
      const result = await apiRequest<{ results: { id: string | null; status: string; error?: string }[] }>("/v1/events/batch", {
        method: "POST",
        body: { events },
        timeoutMs: 15_000
      });
      if (result.status === 401) {
        await markUnauthorized();
        break;
      }
      if (!result.ok || result.status >= 500 || result.status === 0) {
        await markOffline(result.error ?? `HTTP ${result.status}`);
        break;
      }
      const parsed = eventBatchResultSchema.safeParse(result.body);
      if (!parsed.success) {
        await markOffline("invalid batch response");
        break;
      }
      await db.transaction("rw", db.pending_events, db.failed_events, async () => {
        for (const [index, item] of parsed.data.results.entries()) {
          const event = events[index];
          const seq = seqs[index];
          if (!event || seq === undefined) continue;
          if (item.status === "accepted" || item.status === "duplicate" || item.status === "ignored") {
            await db.pending_events.delete(seq);
            synced += 1;
          } else if (item.status === "rejected") {
            await db.pending_events.delete(seq);
            await db.failed_events.put({
              eventId: event.id,
              event,
              error: item.error ?? "rejected",
              failedAt: new Date().toISOString()
            });
            failed += 1;
          }
        }
      });
      const remaining = await pendingCounts();
      publishProgress({ done: synced, total: initial.total, running: true });
      if (remaining.total === 0) break;
    }

    const remaining = await pendingCounts();
    publishProgress({ done: synced, total: initial.total, running: false });
    await updateBadge();
    if (reason === "manual" || synced > 0) {
      browser.runtime.sendMessage({ type: "study-studio:sync-done", synced, knowledge: synced }).catch(() => {});
    }
    return { synced, failed, remaining: remaining.total };
  };

  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request("study-studio-sync", run);
  }
  return run();
}

export function classifyPendingType(type: string): "knowledge" | "record" | "activity" | "other" {
  if (KNOWLEDGE.has(type)) return "knowledge";
  if (RECORD.has(type)) return "record";
  if (ACTIVITY.has(type)) return "activity";
  return "other";
}
