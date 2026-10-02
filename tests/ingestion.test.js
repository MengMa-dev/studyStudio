import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createIngestionServer } from "../services/local-ingestion/src/ingestion-server.js";

const token = "test-token";
const source = { channel: "browser_extension", url: "https://example.com/a", title: "A", isStrongLearning: false };
const base = (type, extra = {}) => ({ id: randomUUID(), schemaVersion: 1, type, occurredAt: "2026-10-01T10:00:00.000Z", source, ...extra });
const webpage = (extra = {}) =>
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

async function start(dataDir) {
  const ingestion = await createIngestionServer({ dataDir, pairingToken: token });
  const port = await ingestion.listen(0);
  const call = async (path, { method = "POST", body, auth = token } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, close: () => ingestion.close() };
}

async function timeline(dataDir) {
  const text = await readFile(join(dataDir, "timeline", "2026-10-01.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("ingestion service validates, persists and deduplicates learning events", async (t) => {
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
  assert.equal(pageResult.body.artifact, `inbox/webpages/page-${page.id}`);
  const folder = join(dataDir, pageResult.body.artifact);
  assert.equal(await readFile(join(folder, "content.md"), "utf8"), "# A\n\nbody");
  assert.match(await readFile(join(folder, "content.txt"), "utf8"), /A body/);
  const metadata = JSON.parse(await readFile(join(folder, "metadata.json"), "utf8"));
  assert.equal(metadata.content.canonicalUrl, "https://example.com/a");
  assert.equal(metadata.content.markdown, undefined);

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
  assert.equal(await readFile(join(dataDir, qaResult.body.artifact, "question.md"), "utf8"), "什么是重排？");
  assert.equal(await readFile(join(dataDir, qaResult.body.artifact, "answer.md"), "utf8"), "**重排**是精排。");

  const entries = await timeline(dataDir);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user_note", "webpage_captured", "assistant_response_completed"]
  );
  assert.equal(entries[1].content.markdown, undefined, "timeline must not duplicate full page bodies");
  assert.equal(entries[1].artifact, pageResult.body.artifact);

  const lookup = (canonicalUrl) => service.call(`/v1/pages?canonicalUrl=${encodeURIComponent(canonicalUrl)}`, { method: "GET" });
  assert.deepEqual((await lookup("https://example.com/a")).body, { captured: true });
  assert.deepEqual((await lookup("https://example.com/b")).body, { captured: false });

  await service.close();
  service = await start(dataDir);
  t.after(() => service.close());

  assert.equal((await service.call("/v1/events", { body: note })).body.duplicate, true, "event ids survive restarts");
  assert.deepEqual((await lookup("https://example.com/a")).body, { captured: true }, "page index survives restarts");
  const changedContent = webpage();
  changedContent.content = { ...changedContent.content, contentHash: "changed", plainText: "B body ".repeat(40) };
  const samePage = await service.call("/v1/events", { body: changedContent });
  assert.equal(samePage.body.duplicatePage, true, "same canonical URL is never captured twice, even if content changed");
  assert.equal(samePage.body.artifact, pageResult.body.artifact);
  assert.equal((await readdir(join(dataDir, "inbox", "webpages"))).length, 1);
  assert.equal((await timeline(dataDir)).length, 3, "duplicate pages and navigation stay out of the timeline");
});

test("reading time accumulates on captured pages: capturing stay always, later stays only from 60s", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await start(dataDir);
  t.after(() => service.close());
  const pageSource = { ...source, canonicalUrl: "https://example.com/a" };
  const closed = (sessionId, seconds) => base("reading_session_closed", { source: pageSource, sessionId, readingSignals: { activeDurationSeconds: seconds } });

  assert.equal((await service.call("/v1/events", { body: closed("s0", 300) })).status, 202, "uncaptured pages get no reading time");
  assert.equal((await service.call("/v1/events", { body: { ...closed("s0", 300), source } })).status, 422, "canonicalUrl is required");

  const page = await service.call("/v1/events", { body: webpage({ sessionId: "s1" }) });
  const first = await service.call("/v1/events", { body: closed("s1", 45) });
  assert.equal(first.status, 201, "the capturing stay counts even below 60s");
  assert.deepEqual([first.body.readingStats.totalActiveSeconds, first.body.readingStats.sessionCount], [45, 1]);

  assert.equal((await service.call("/v1/events", { body: closed("s2", 59) })).status, 202, "later stays under 60s are ignored");
  const later = await service.call("/v1/events", { body: closed("s3", 75) });
  assert.equal(later.status, 201);
  assert.deepEqual([later.body.readingStats.totalActiveSeconds, later.body.readingStats.sessionCount], [120, 2]);

  const metadata = JSON.parse(await readFile(join(dataDir, page.body.artifact, "metadata.json"), "utf8"));
  assert.equal(metadata.readingStats.totalActiveSeconds, 120);
  assert.equal(metadata.sessionId, "s1");
  const entries = await timeline(dataDir);
  assert.deepEqual(
    entries.map((entry) => [entry.type, entry.countedSeconds]),
    [
      ["webpage_captured", undefined],
      ["reading_session_closed", 45],
      ["reading_session_closed", 75]
    ]
  );
  assert.equal(entries[2].totalActiveSeconds, 120);
});
