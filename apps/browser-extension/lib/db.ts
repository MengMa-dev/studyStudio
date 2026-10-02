import { Dexie, type EntityTable } from "dexie";
import type { CollectorSettings } from "@study-studio/shared";

export type CollectorEvent = { id: string; type: string; occurredAt: string } & Record<string, unknown>;

export type PendingEventRow = {
  seq?: number;
  event: CollectorEvent;
  eventId: string;
  type: string;
  occurredAt: string;
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
};

export type FailedEventRow = {
  eventId: string;
  event: CollectorEvent;
  error: string;
  failedAt: string;
};

export type MetaRow = {
  key: string;
  value: unknown;
};

class StudyStudioDb extends Dexie {
  pending_events!: EntityTable<PendingEventRow, "seq">;
  failed_events!: EntityTable<FailedEventRow, "eventId">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("study-studio");
    this.version(1).stores({
      pending_events: "++seq, eventId, type, occurredAt",
      failed_events: "eventId",
      meta: "key"
    });
  }
}

export const db = new StudyStudioDb();

export const META_KEYS = {
  settings: "settings",
  settingsEtag: "settingsEtag",
  capturedUrls: "capturedUrls"
} as const;

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export async function enqueueEvent(event: CollectorEvent): Promise<void> {
  const existing = await db.pending_events.where("eventId").equals(event.id).first();
  if (existing) return;
  await db.pending_events.add({
    event,
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    attempts: 0,
    lastError: null,
    enqueuedAt: new Date().toISOString()
  });
}

export async function pendingCounts(): Promise<{ knowledge: number; records: number; total: number; activity: number }> {
  const rows = await db.pending_events.toArray();
  const knowledgeTypes = new Set(["webpage_captured", "assistant_response_completed", "user_note"]);
  const recordTypes = new Set(["user_message_sent", "reading_session_closed"]);
  const activityTypes = new Set(["page_session", "search_performed", "selection", "copy", "activity_state"]);
  let knowledge = 0;
  let records = 0;
  let activity = 0;
  for (const row of rows) {
    if (knowledgeTypes.has(row.type)) knowledge += 1;
    else if (recordTypes.has(row.type)) records += 1;
    else if (activityTypes.has(row.type)) activity += 1;
  }
  return { knowledge, records, total: rows.length, activity };
}

export async function listFailed(): Promise<FailedEventRow[]> {
  return db.failed_events.toArray();
}

export async function clearFailed(): Promise<void> {
  await db.failed_events.clear();
}

export async function lookupPendingCapture(canonicalUrl: string): Promise<boolean> {
  const rows = await db.pending_events.where("type").equals("webpage_captured").toArray();
  return rows.some((row) => {
    const content = row.event.content as { canonicalUrl?: string } | undefined;
    const source = row.event.source as { canonicalUrl?: string } | undefined;
    return content?.canonicalUrl === canonicalUrl || source?.canonicalUrl === canonicalUrl;
  });
}

export async function rememberCapturedUrl(canonicalUrl: string): Promise<void> {
  const urls = (await getMeta<string[]>(META_KEYS.capturedUrls)) ?? [];
  if (!urls.includes(canonicalUrl)) {
    urls.push(canonicalUrl);
    if (urls.length > 2000) urls.splice(0, urls.length - 2000);
    await setMeta(META_KEYS.capturedUrls, urls);
  }
}

export async function wasCapturedLocally(canonicalUrl: string): Promise<boolean> {
  const urls = (await getMeta<string[]>(META_KEYS.capturedUrls)) ?? [];
  if (urls.includes(canonicalUrl)) return true;
  return lookupPendingCapture(canonicalUrl);
}

export type CachedSettings = CollectorSettings;
