import type { DatabaseSync } from "node:sqlite";
import { activeDirections, categorizeDomain, type DomainCategory } from "@study-studio/shared";
import type { EventRow } from "../../db/types.js";
import { getLearnerProfile } from "../settings/settings.js";
import { EPISODE_PARAMS } from "./constants.js";
import { parseJson, type OrganizeItem } from "./store.js";
import type { CapturedItemRef, OrganizeLearnerProfile, TimelineUnit } from "./types.js";

/** ① Context Loader: activity window around the anchor items, converted into ② timeline units. */

const MS_PER_MIN = 60_000;
const TIMELINE_EVENT_TYPES = ["page_session", "search_performed", "selection", "copy", "activity_state", "user_note", "assistant_response_completed"];

export type JudgeProfile = { role: string; learning_focus: Array<{ topic: string; expires_at: string }> };

export function loadLearnerProfile(db: DatabaseSync, now: Date): JudgeProfile {
  const profile = getLearnerProfile(db);
  const today = now.toISOString().slice(0, 10);
  return {
    role: profile.role ?? "",
    learning_focus: activeDirections(profile, today).map((direction) => ({ topic: direction.text, expires_at: direction.expiresAt }))
  };
}

export function toOrganizeProfile(profile: JudgeProfile): OrganizeLearnerProfile {
  return { role: profile.role, learning_focus: profile.learning_focus };
}

type Window = { start: number; end: number };

/** Merge anchor timestamps into windows padded by `hardGapMinutes` on both sides. */
export function anchorWindows(capturedAts: string[], hardGapMinutes = EPISODE_PARAMS.hardGapMinutes): Window[] {
  const pad = hardGapMinutes * MS_PER_MIN;
  const times = capturedAts
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b);
  const windows: Window[] = [];
  for (const time of times) {
    const last = windows[windows.length - 1];
    if (last && time - pad <= last.end) last.end = Math.max(last.end, time + pad);
    else windows.push({ start: time - pad, end: time + pad });
  }
  return windows;
}

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type Payload = Record<string, unknown> & {
  session?: {
    tabId?: number;
    openerTabId?: number;
    domain?: string;
    category?: DomainCategory;
    url?: string;
    title?: string;
    referrer?: string;
    transition?: string;
    startedAt?: string;
    endedAt?: string;
    visibleSeconds?: number;
    maxScrollDepth?: number;
    revisit?: boolean;
    captured?: boolean;
  };
  search?: { engine?: string; query?: string; tabId?: number };
  snippet?: { text?: string; isCode?: boolean };
  state?: "idle" | "active" | "blur" | "focus";
  note?: { text?: string };
  conversationId?: string;
  question?: { preview?: string };
  source?: { platform?: string; url?: string };
};

export function eventToUnit(row: EventRow, turnIndex: Map<string, number>): TimelineUnit | null {
  const payload = parseJson<Payload>(row.payload, {});
  switch (row.type) {
    case "page_session": {
      const session = payload.session;
      if (!session) return null;
      return {
        kind: "page_session",
        id: row.id,
        occurredAt: row.occurred_at,
        domain: session.domain ?? domainOf(session.url),
        category: session.category ?? categorizeDomain(session.domain ?? ""),
        url: session.url,
        title: session.title,
        referrer: session.referrer,
        openerTabId: session.openerTabId,
        tabId: session.tabId,
        transition: session.transition,
        startedAt: session.startedAt ?? row.occurred_at,
        endedAt: session.endedAt ?? row.occurred_at,
        visibleSeconds: session.visibleSeconds ?? 0,
        maxScrollDepth: session.maxScrollDepth,
        revisit: session.revisit,
        captured: session.captured,
        itemId: row.item_id
      };
    }
    case "search_performed":
      if (!payload.search?.query) return null;
      return {
        kind: "search",
        id: row.id,
        occurredAt: row.occurred_at,
        engine: payload.search.engine ?? "",
        query: payload.search.query,
        tabId: payload.search.tabId
      };
    case "selection":
    case "copy":
      if (!payload.snippet?.text) return null;
      return {
        kind: row.type,
        id: row.id,
        occurredAt: row.occurred_at,
        text: payload.snippet.text,
        isCode: Boolean(payload.snippet.isCode),
        url: row.url ?? undefined,
        itemId: row.item_id
      };
    case "activity_state":
      if (!payload.state) return null;
      return { kind: "activity_state", id: row.id, occurredAt: row.occurred_at, state: payload.state };
    case "user_note":
      if (!payload.note?.text) return null;
      return { kind: "note", id: row.id, occurredAt: row.occurred_at, text: payload.note.text, itemId: row.item_id };
    case "assistant_response_completed": {
      const conversationId = payload.conversationId ?? row.url ?? row.id;
      const index = (turnIndex.get(conversationId) ?? 0) + 1;
      turnIndex.set(conversationId, index);
      return {
        kind: "ai_turn",
        id: row.id,
        occurredAt: row.occurred_at,
        platform: payload.source?.platform,
        conversationId,
        question: payload.question?.preview,
        turnIndex: index,
        itemId: row.item_id
      };
    }
    default:
      return null;
  }
}

/** A unit for items without any activity event (e.g. imported or captured with tracking off). */
function syntheticUnit(item: OrganizeItem): TimelineUnit {
  if (item.type === "conversation") {
    return {
      kind: "ai_turn",
      id: `item:${item.id}`,
      occurredAt: item.capturedAt,
      conversationId: item.conversationId ?? `item:${item.id}`,
      question: item.question ?? item.title,
      turnIndex: 1,
      itemId: item.id
    };
  }
  const domain = item.site ?? domainOf(item.url);
  const seconds = Math.max(item.readingSeconds, 60);
  const start = new Date(Date.parse(item.capturedAt) - seconds * 1000).toISOString();
  return {
    kind: "page_session",
    id: `item:${item.id}`,
    occurredAt: start,
    domain,
    category: categorizeDomain(domain),
    url: item.url ?? undefined,
    title: item.title,
    startedAt: start,
    endedAt: item.capturedAt,
    visibleSeconds: seconds,
    itemId: item.id
  };
}

export type TimelineContext = {
  units: TimelineUnit[];
  items: CapturedItemRef[];
};

export function loadTimeline(db: DatabaseSync, anchors: OrganizeItem[], hardGapMinutes = EPISODE_PARAMS.hardGapMinutes): TimelineContext {
  const windows = anchorWindows(
    anchors.map((item) => item.capturedAt),
    hardGapMinutes
  );
  const placeholders = TIMELINE_EVENT_TYPES.map(() => "?").join(",");
  const selectEvents = db.prepare(`SELECT * FROM events WHERE type IN (${placeholders}) AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at, id`);
  const selectItems = db.prepare(
    "SELECT id, type, title, url, canonical_url, site, captured_at, content_hash FROM items WHERE deleted_at IS NULL AND captured_at BETWEEN ? AND ?"
  );

  const units: TimelineUnit[] = [];
  const items = new Map<string, CapturedItemRef>();
  const seen = new Set<string>();
  const turnIndex = new Map<string, number>();
  for (const window of windows) {
    const from = new Date(window.start).toISOString();
    const to = new Date(window.end).toISOString();
    for (const row of selectEvents.all(...TIMELINE_EVENT_TYPES, from, to) as EventRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const unit = eventToUnit(row, turnIndex);
      if (unit) units.push(unit);
    }
    for (const row of selectItems.all(from, to) as Array<{
      id: string;
      type: CapturedItemRef["type"];
      title: string | null;
      url: string | null;
      canonical_url: string | null;
      site: string | null;
      captured_at: string;
      content_hash: string | null;
    }>) {
      items.set(row.id, {
        id: row.id,
        type: row.type,
        title: row.title,
        url: row.url,
        canonicalUrl: row.canonical_url,
        site: row.site,
        capturedAt: row.captured_at,
        contentHash: row.content_hash
      });
    }
  }

  const referenced = new Set(units.flatMap((unit) => ("itemId" in unit && unit.itemId ? [unit.itemId] : [])));
  for (const anchor of anchors) {
    if (!referenced.has(anchor.id)) units.push(syntheticUnit(anchor));
  }
  return { units, items: [...items.values()] };
}
