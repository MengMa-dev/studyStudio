import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createIngestionServer } from "../src/create-server.js";
import type { DatabaseSync } from "node:sqlite";

const token = "test-token";
const source = { channel: "browser_extension" as const, url: "https://example.com/a", title: "A", isStrongLearning: false };
const base = (type: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  schemaVersion: 1,
  type,
  occurredAt: "2026-10-01T10:00:00.000Z",
  source,
  ...extra
});
const webpage = (extra: Record<string, unknown> = {}) =>
  base("webpage_captured", {
    reason: "threshold",
    readingSignals: { activeDurationSeconds: 95, maxScrollDepth: 0.5 },
    content: {
      title: "A",
      canonicalUrl: "https://example.com/a",
      markdown: "# A\n\nbody",
      plainText: "A body ".repeat(40),
      sanitizedHtml: "<h1>A</h1>",
      contentHash: "abc",
      extractor: "defuddle",
      media: []
    },
    ...extra
  });

async function start(dataDir: string, opts: { memory?: boolean; minRevisitSeconds?: number } = {}) {
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken: token,
    disableScheduler: true,
    skipVector: true,
    memory: opts.memory ?? false,
    minRevisitSeconds: opts.minRevisitSeconds
  });
  const port = await ingestion.listen(0);
  const call = async (
    path: string,
    { method = "POST", body, auth = token, headers = {} }: { method?: string; body?: unknown; auth?: string | null; headers?: Record<string, string> } = {}
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: response.status, body: json as Record<string, unknown>, headers: response.headers, etag: response.headers.get("etag") };
  };
  return { call, close: () => ingestion.close(), db: ingestion.db.db, port, ingestion };
}

function count(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

test("ingestion validates, persists to SQLite and deduplicates learning events", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = await start(dataDir);

  assert.equal((await service.call("/v1/events", { body: base("page_opened"), auth: "wrong" })).status, 401);
  assert.equal((await service.call("/v1/pairing", { method: "GET" })).status, 200);
  assert.equal((await service.call("/v1/events", { body: base("user_note", { note: { text: "" } }) })).status, 422);
  assert.equal((await service.call("/v1/events", { body: { ...base("page_opened"), id: "../../etc" } })).status, 422);
  assert.equal((await service.call("/v1/events", { body: { ...base("page_opened"), source: { channel: "unknown" } } })).status, 422);

  const opened = await service.call("/v1/events", { body: base("page_opened") });
  assert.deepEqual([opened.status, opened.body], [202, { accepted: true, ignored: true }], "navigation is not a learning event");

  const note = base("user_note", { note: { text: "召回与重排的分工" } });
  assert.equal((await service.call("/v1/events", { body: note })).status, 201);
  assert.deepEqual((await service.call("/v1/events", { body: note })).body, { accepted: true, duplicate: true });

  const page = webpage();
  const pageResult = await service.call("/v1/events", { body: page });
  assert.equal(pageResult.status, 201);
  assert.ok(typeof pageResult.body.itemId === "string");
  assert.match(String(pageResult.body.artifact), /^inbox\/webpages\//);

  const itemId = String(pageResult.body.itemId);
  const content = service.db.prepare("SELECT markdown, plain_text FROM item_contents WHERE item_id = ?").get(itemId) as {
    markdown: string;
    plain_text: string;
  };
  assert.equal(content.markdown, "# A\n\nbody");
  assert.match(content.plain_text, /A body/);
  const item = service.db.prepare("SELECT canonical_url FROM items WHERE id = ?").get(itemId) as { canonical_url: string };
  assert.equal(item.canonical_url, "https://example.com/a");

  const qa = base("assistant_response_completed", {
    replyTo: "q1",
    question: { id: "q1", plainText: "什么是重排？" },
    answer: {
      role: "assistant",
      plainText: "重排是精排。",
      markdown: "**重排**是精排。",
      sanitizedHtml: "<p><strong>重排</strong>是精排。</p>",
      contentHash: "h"
    }
  });
  const qaResult = await service.call("/v1/events", { body: qa });
  assert.equal(qaResult.status, 201);
  const qaItem = String(qaResult.body.itemId);
  const qaContent = service.db.prepare("SELECT question, markdown FROM item_contents WHERE item_id = ?").get(qaItem) as {
    question: string;
    markdown: string;
  };
  assert.equal(qaContent.question, "什么是重排？");
  assert.equal(qaContent.markdown, "**重排**是精排。");

  const types = (service.db.prepare("SELECT type FROM events WHERE type != 'page_opened' ORDER BY received_at").all() as { type: string }[]).map(
    (row) => row.type
  );
  assert.deepEqual(types, ["user_note", "webpage_captured", "assistant_response_completed"]);
  const webpageEvent = service.db.prepare("SELECT payload FROM events WHERE type = 'webpage_captured'").get() as { payload: string };
  assert.equal(JSON.parse(webpageEvent.payload).content.markdown, undefined, "events must not store full page bodies");

  const lookup = (canonicalUrl: string) => service.call(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`, { method: "GET" });
  assert.deepEqual((await lookup("https://example.com/a")).body, { captured: true });
  assert.deepEqual((await lookup("https://example.com/b")).body, { captured: false });

  await service.close();
  service = await start(dataDir);
  t.after(() => service.close());

  assert.equal((await service.call("/v1/events", { body: note })).body.duplicate, true, "event ids survive restarts");
  assert.deepEqual((await lookup("https://example.com/a")).body, { captured: true }, "page index survives restarts");
  const changedContent = webpage() as ReturnType<typeof webpage> & {
    content: Record<string, unknown>;
  };
  changedContent.content = { ...changedContent.content, contentHash: "changed", plainText: "B body ".repeat(40) };
  const samePage = await service.call("/v1/events", { body: changedContent });
  assert.equal(samePage.body.duplicatePage, true, "same canonical URL is never captured twice, even if content changed");
  assert.equal(count(service.db, "SELECT COUNT(*) AS n FROM items WHERE type = 'webpage' AND deleted_at IS NULL"), 1);
  assert.equal(count(service.db, "SELECT COUNT(*) AS n FROM events"), 3, "duplicate pages and navigation stay out of the timeline");
});

test("reading time accumulates on captured pages: capturing stay always, later stays only from 60s", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await start(dataDir);
  t.after(() => service.close());
  const pageSource = { ...source, canonicalUrl: "https://example.com/a" };
  const closed = (sessionId: string, seconds: number) =>
    base("reading_session_closed", { source: pageSource, sessionId, readingSignals: { activeDurationSeconds: seconds } });

  assert.equal((await service.call("/v1/events", { body: closed("s0", 300) })).status, 202, "uncaptured pages get no reading time");
  assert.equal((await service.call("/v1/events", { body: { ...closed("s0", 300), source } })).status, 422, "canonicalUrl is required");

  const page = await service.call("/v1/events", { body: webpage({ sessionId: "s1" }) });
  const first = await service.call("/v1/events", { body: closed("s1", 45) });
  assert.equal(first.status, 201, "the capturing stay counts even below 60s");
  const stats = first.body.readingStats as { totalActiveSeconds: number; sessionCount: number };
  assert.deepEqual([stats.totalActiveSeconds, stats.sessionCount], [45, 1]);

  assert.equal((await service.call("/v1/events", { body: closed("s2", 59) })).status, 202, "later stays under 60s are ignored");
  const later = await service.call("/v1/events", { body: closed("s3", 75) });
  assert.equal(later.status, 201);
  const laterStats = later.body.readingStats as { totalActiveSeconds: number; sessionCount: number };
  assert.deepEqual([laterStats.totalActiveSeconds, laterStats.sessionCount], [120, 2]);

  const item = service.db.prepare("SELECT reading_total_seconds, capture_session_id FROM items WHERE id = ?").get(String(page.body.itemId)) as {
    reading_total_seconds: number;
    capture_session_id: string;
  };
  assert.equal(item.reading_total_seconds, 120);
  assert.equal(item.capture_session_id, "s1");

  const entries = service.db
    .prepare("SELECT type, payload FROM events WHERE type IN ('webpage_captured','reading_session_closed') ORDER BY received_at")
    .all() as { type: string; payload: string }[];
  assert.deepEqual(
    entries.map((entry) => [entry.type, JSON.parse(entry.payload).countedSeconds]),
    [
      ["webpage_captured", undefined],
      ["reading_session_closed", 45],
      ["reading_session_closed", 75]
    ]
  );
  assert.equal(JSON.parse(entries[2]!.payload).totalActiveSeconds, 120);
});
