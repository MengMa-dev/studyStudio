import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ACTIVITY_EVENT_TYPES, IGNORED_EVENT_TYPES, type CollectorEvent, type EventOf, type Exposure } from "@study-studio/shared";
import { withTransaction, type AppDatabase } from "../../db/database.js";
import type { ItemRow } from "../../db/types.js";
import { storeInlineMedia } from "../data/blobs.js";
import { eventUrlForRules, listRules, matchesExclusionRule } from "./rules.js";
import { getStoredCollectorSettings } from "../settings/settings.js";
import { updateCompatReadingStats, writeCompatArtifact } from "./compat-fs.js";

const ACTIVITY_SET = new Set<string>(ACTIVITY_EVENT_TYPES);
const IGNORED_SET = new Set<string>(IGNORED_EVENT_TYPES);

export type IngestStatus = "accepted" | "duplicate" | "ignored" | "rejected";

export type IngestResult = {
  status: IngestStatus;
  httpStatus: number;
  body: Record<string, unknown>;
  error?: string;
};

export type IngestContext = {
  app: AppDatabase;
  /** Override min revisit seconds (tests / DEV). */
  minRevisitSeconds?: number;
};

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function siteOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function eventExists(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS ok FROM events WHERE id = ?").get(id));
}

function findWebpageByCanonical(db: DatabaseSync, canonicalUrl: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM items WHERE type = 'webpage' AND canonical_url = ? AND deleted_at IS NULL LIMIT 1").get(canonicalUrl) as ItemRow | undefined;
}

function findItemByUrl(db: DatabaseSync, url: string | undefined | null): ItemRow | undefined {
  if (!url) return undefined;
  const byCanonical = db.prepare("SELECT * FROM items WHERE canonical_url = ? AND deleted_at IS NULL LIMIT 1").get(url) as ItemRow | undefined;
  if (byCanonical) return byCanonical;
  return db.prepare("SELECT * FROM items WHERE url = ? AND deleted_at IS NULL LIMIT 1").get(url) as ItemRow | undefined;
}

function insertEvent(db: DatabaseSync, event: CollectorEvent, payload: unknown, itemId: string | null, receivedAt: string): void {
  const source = event.source;
  const url = "content" in event && event.type === "webpage_captured" ? event.content.canonicalUrl : (source.url ?? null);
  const canonical =
    event.type === "webpage_captured"
      ? event.content.canonicalUrl
      : event.type === "reading_session_closed"
        ? event.source.canonicalUrl
        : (source.canonicalUrl ?? null);
  db.prepare(
    `INSERT INTO events(id, type, occurred_at, day, channel, site, url, canonical_url, session_id, item_id, payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.type,
    event.occurredAt,
    dayOf(event.occurredAt),
    source.channel ?? null,
    siteOf(url ?? canonical),
    url,
    canonical,
    "sessionId" in event ? ((event as { sessionId?: string }).sessionId ?? null) : null,
    itemId,
    JSON.stringify(payload),
    receivedAt
  );
}

/** Strip bodies from the event payload stored in `events`. */
function leanPayload(event: CollectorEvent): unknown {
  if (event.type === "webpage_captured") {
    const { content, ...rest } = event;
    return {
      ...rest,
      content: {
        title: content.title,
        canonicalUrl: content.canonicalUrl,
        contentHash: content.contentHash,
        extractor: content.extractor
      }
    };
  }
  if (event.type === "assistant_response_completed") {
    const { answer, question, ...rest } = event;
    return {
      ...rest,
      question: question ? { id: question.id, preview: question.plainText?.slice(0, 200) } : undefined,
      answer: { contentHash: answer.contentHash, preview: answer.plainText.slice(0, 200) }
    };
  }
  if (event.type === "user_message_sent") {
    const { message, ...rest } = event;
    return { ...rest, message: { preview: message.plainText.slice(0, 200), contentHash: message.contentHash } };
  }
  return event;
}

function artifactFor(itemId: string, type: "webpage" | "conversation"): string {
  return type === "webpage" ? `inbox/webpages/page-${itemId}` : `inbox/conversations/qa-${itemId}`;
}

function ingestWebpage(ctx: IngestContext, event: EventOf<"webpage_captured">, receivedAt: string): IngestResult {
  const { db, dataDir } = ctx.app;
  const existing = findWebpageByCanonical(db, event.content.canonicalUrl);
  if (existing) {
    return {
      status: "duplicate",
      httpStatus: 200,
      body: { accepted: true, duplicatePage: true, artifact: artifactFor(existing.id, "webpage"), itemId: existing.id }
    };
  }

  const itemId = randomUUID();
  db.prepare(
    `INSERT INTO items(id, type, title, url, canonical_url, site, captured_at, reason, is_strong_learning, content_hash, capture_session_id)
     VALUES (?, 'webpage', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    event.content.title ?? event.source.title ?? null,
    event.source.url ?? event.content.canonicalUrl,
    event.content.canonicalUrl,
    siteOf(event.content.canonicalUrl),
    event.occurredAt,
    event.reason ?? null,
    event.source.isStrongLearning ? 1 : 0,
    event.content.contentHash ?? null,
    event.sessionId ?? null
  );

  db.prepare(
    `INSERT INTO item_contents(item_id, markdown, plain_text, sanitized_html, extractor, meta)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    event.content.markdown ?? null,
    event.content.plainText,
    event.content.sanitizedHtml ?? null,
    event.content.extractor ?? null,
    JSON.stringify({ media: event.content.media ?? [] })
  );

  const assets = storeInlineMedia(dataDir, event.content.media);
  const insertAsset = db.prepare(`INSERT INTO assets(id, item_id, kind, sha256, mime, size, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const asset of assets) {
    insertAsset.run(randomUUID(), itemId, asset.kind, asset.sha256, asset.mime, asset.size, asset.source_url);
  }

  insertEvent(db, event, leanPayload(event), itemId, receivedAt);
  writeCompatArtifact(dataDir, event, itemId);
  return {
    status: "accepted",
    httpStatus: 201,
    body: { accepted: true, id: event.id, artifact: artifactFor(itemId, "webpage"), itemId }
  };
}

function ingestConversation(ctx: IngestContext, event: EventOf<"assistant_response_completed">, receivedAt: string): IngestResult {
  const { db } = ctx.app;
  const itemId = randomUUID();
  db.prepare(
    `INSERT INTO items(id, type, title, url, canonical_url, site, captured_at, reason, is_strong_learning, content_hash)
     VALUES (?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    event.question?.plainText?.slice(0, 120) ?? event.source.title ?? "conversation",
    event.source.url ?? null,
    event.source.canonicalUrl ?? event.source.url ?? null,
    siteOf(event.source.url),
    event.occurredAt,
    null,
    event.source.isStrongLearning ? 1 : 0,
    event.answer.contentHash ?? null
  );

  db.prepare(
    `INSERT INTO item_contents(item_id, markdown, plain_text, sanitized_html, question, reasoning, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    event.answer.markdown ?? event.answer.plainText,
    event.answer.plainText,
    event.answer.sanitizedHtml ?? null,
    event.question?.plainText ?? null,
    null,
    JSON.stringify({
      replyTo: event.replyTo,
      conversationId: "conversationId" in event ? event.conversationId : undefined,
      questionId: event.question?.id
    })
  );

  insertEvent(db, event, leanPayload(event), itemId, receivedAt);

  if (event.replyTo) {
    db.prepare(`UPDATE events SET item_id = ? WHERE id = ? AND type = 'user_message_sent'`).run(itemId, event.replyTo);
  }

  writeCompatArtifact(ctx.app.dataDir, event, itemId);
  return {
    status: "accepted",
    httpStatus: 201,
    body: { accepted: true, id: event.id, artifact: artifactFor(itemId, "conversation"), itemId }
  };
}

function ingestUserMessage(ctx: IngestContext, event: EventOf<"user_message_sent">, receivedAt: string): IngestResult {
  insertEvent(ctx.app.db, event, leanPayload(event), null, receivedAt);
  return { status: "accepted", httpStatus: 201, body: { accepted: true, id: event.id } };
}

function ingestNote(ctx: IngestContext, event: EventOf<"user_note">, receivedAt: string): IngestResult {
  const { db } = ctx.app;
  const activeUrl = event.context?.activeSourceUrl ?? event.source.canonicalUrl ?? event.source.url;
  const item = findItemByUrl(db, activeUrl);
  const noteId = randomUUID();
  const scope = item ? "item" : "fuzzy";
  db.prepare(`INSERT INTO notes(id, scope, target_id, text, origin, created_at) VALUES (?, ?, ?, ?, 'extension', ?)`).run(
    noteId,
    scope,
    item?.id ?? null,
    event.note.text,
    event.occurredAt
  );
  insertEvent(db, event, leanPayload(event), item?.id ?? null, receivedAt);
  writeCompatArtifact(ctx.app.dataDir, event, item?.id ?? noteId);
  return {
    status: "accepted",
    httpStatus: 201,
    body: { accepted: true, id: event.id, noteId, scope, itemId: item?.id }
  };
}

function ingestReading(ctx: IngestContext, event: EventOf<"reading_session_closed">, receivedAt: string): IngestResult {
  const { db } = ctx.app;
  const settings = getStoredCollectorSettings(db);
  const minRevisit = ctx.minRevisitSeconds ?? settings.captureRules.minRevisitSeconds;
  const ignored: IngestResult = { status: "ignored", httpStatus: 202, body: { accepted: true, ignored: true } };

  const item = findWebpageByCanonical(db, event.source.canonicalUrl);
  if (!item) return ignored;

  const seconds = Math.floor(event.readingSignals.activeDurationSeconds);
  const capturingStay = Boolean(event.sessionId) && event.sessionId === item.capture_session_id;
  if (seconds <= 0 || (!capturingStay && seconds < minRevisit)) return ignored;

  const isFirst = capturingStay || item.reading_session_count === 0 ? 1 : 0;
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO reading_sessions(id, item_id, started_at, seconds, is_first) VALUES (?, ?, ?, ?, ?)`).run(
    sessionId,
    item.id,
    event.openedAt ?? null,
    seconds,
    isFirst
  );

  const total = (item.reading_total_seconds ?? 0) + seconds;
  const count = (item.reading_session_count ?? 0) + 1;
  db.prepare(`UPDATE items SET reading_total_seconds = ?, reading_session_count = ?, last_read_at = ? WHERE id = ?`).run(
    total,
    count,
    event.occurredAt,
    item.id
  );

  insertEvent(db, event, { ...(leanPayload(event) as Record<string, unknown>), countedSeconds: seconds, totalActiveSeconds: total }, item.id, receivedAt);
  updateCompatReadingStats(ctx.app.dataDir, item.id, { totalActiveSeconds: total, sessionCount: count, lastReadAt: event.occurredAt });
  writeCompatArtifact(ctx.app.dataDir, event, item.id, { countedSeconds: seconds, totalActiveSeconds: total });

  return {
    status: "accepted",
    httpStatus: 201,
    body: {
      accepted: true,
      id: event.id,
      artifact: artifactFor(item.id, "webpage"),
      itemId: item.id,
      readingStats: { totalActiveSeconds: total, sessionCount: count, lastReadAt: event.occurredAt }
    }
  };
}

function mergeTopBlocks(existing: { fp: string; exposed_seconds: number }[] | null, incoming: { fp: string; exposed_seconds: number }[] | undefined): string {
  const map = new Map<string, number>();
  for (const block of existing ?? []) map.set(block.fp, (map.get(block.fp) ?? 0) + block.exposed_seconds);
  for (const block of incoming ?? []) map.set(block.fp, (map.get(block.fp) ?? 0) + block.exposed_seconds);
  const top = [...map.entries()]
    .map(([fp, exposed_seconds]) => ({ fp, exposed_seconds }))
    .sort((a, b) => b.exposed_seconds - a.exposed_seconds)
    .slice(0, 10);
  return JSON.stringify(top);
}

function accumulateExposure(db: DatabaseSync, itemId: string, exposure: Exposure | undefined, updatedAt: string): void {
  if (!exposure?.sections?.length) return;
  const select = db.prepare("SELECT * FROM item_exposure WHERE item_id = ? AND section_key = ?");
  const upsert = db.prepare(
    `INSERT INTO item_exposure(item_id, section_key, heading, chars, exposed_seconds, coverage, top_blocks, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, section_key) DO UPDATE SET
       heading = excluded.heading,
       chars = excluded.chars,
       exposed_seconds = excluded.exposed_seconds,
       coverage = excluded.coverage,
       top_blocks = excluded.top_blocks,
       updated_at = excluded.updated_at`
  );

  for (const section of exposure.sections) {
    const prev = select.get(itemId, section.key) as
      { exposed_seconds: number | null; chars: number | null; top_blocks: string | null; coverage: number | null } | undefined;
    const exposed = (prev?.exposed_seconds ?? 0) + section.exposed_seconds;
    const chars = section.chars || prev?.chars || 0;
    // Recompute coverage from cumulative seconds using the same expected-seconds heuristic as 01.
    const expectedSeconds = chars > 0 ? chars / (400 / 60) : 0;
    const coverage = expectedSeconds > 0 ? Math.min(1, exposed / expectedSeconds) : section.coverage;
    let prevBlocks: { fp: string; exposed_seconds: number }[] | null = null;
    if (prev?.top_blocks) {
      try {
        prevBlocks = JSON.parse(prev.top_blocks) as { fp: string; exposed_seconds: number }[];
      } catch {
        prevBlocks = null;
      }
    }
    const topBlocks = mergeTopBlocks(prevBlocks, exposure.top_blocks);
    upsert.run(itemId, section.key, section.heading, chars, exposed, coverage, topBlocks, updatedAt);
  }
}

function ingestActivity(ctx: IngestContext, event: CollectorEvent, receivedAt: string): IngestResult {
  const { db } = ctx.app;
  const settings = getStoredCollectorSettings(db);
  if (!settings.activityTracking.enabled && ACTIVITY_SET.has(event.type)) {
    return { status: "ignored", httpStatus: 202, body: { accepted: true, ignored: true } };
  }

  const itemId =
    event.type === "page_session"
      ? (findItemByUrl(db, event.session.url ?? event.source.url ?? event.source.canonicalUrl)?.id ?? null)
      : (findItemByUrl(db, event.source.url ?? event.source.canonicalUrl)?.id ?? null);

  insertEvent(db, event, leanPayload(event), itemId, receivedAt);

  if (event.type === "page_session" && itemId && event.session.exposure) {
    accumulateExposure(db, itemId, event.session.exposure, event.occurredAt);
  }

  return { status: "accepted", httpStatus: 201, body: { accepted: true, id: event.id, itemId } };
}

function ingestOne(ctx: IngestContext, event: CollectorEvent): IngestResult {
  const { db } = ctx.app;
  if (eventExists(db, event.id)) {
    return { status: "duplicate", httpStatus: 200, body: { accepted: true, duplicate: true } };
  }

  const rules = listRules(db);
  const url = eventUrlForRules(event as { source?: { url?: string; canonicalUrl?: string }; content?: { canonicalUrl?: string } });
  if (matchesExclusionRule(url, rules)) {
    return { status: "ignored", httpStatus: 202, body: { accepted: true, ignored: true } };
  }

  if (IGNORED_SET.has(event.type)) {
    return { status: "ignored", httpStatus: 202, body: { accepted: true, ignored: true } };
  }

  const receivedAt = new Date().toISOString();

  switch (event.type) {
    case "webpage_captured":
      return ingestWebpage(ctx, event, receivedAt);
    case "assistant_response_completed":
      return ingestConversation(ctx, event, receivedAt);
    case "user_message_sent":
      return ingestUserMessage(ctx, event, receivedAt);
    case "user_note":
      return ingestNote(ctx, event, receivedAt);
    case "reading_session_closed":
      return ingestReading(ctx, event, receivedAt);
    case "page_session":
    case "search_performed":
    case "selection":
    case "copy":
    case "activity_state":
      return ingestActivity(ctx, event, receivedAt);
    default:
      return { status: "ignored", httpStatus: 202, body: { accepted: true, ignored: true } };
  }
}

/** Single-event ingest in one SQLite transaction. */
export function ingest(ctx: IngestContext, event: CollectorEvent): IngestResult {
  return withTransaction(ctx.app.db, () => ingestOne(ctx, event));
}

export function pageCaptured(db: DatabaseSync, canonicalUrl: string): boolean {
  return Boolean(findWebpageByCanonical(db, canonicalUrl));
}
