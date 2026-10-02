import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_SCHEMAS, collectorEventSchema, eventBatchRequestSchema, MAX_BATCH_EVENTS } from "../src/index";

const base = (type: string, extra: Record<string, unknown> = {}) => ({
  id: "evt-12345678",
  schemaVersion: 1,
  type,
  occurredAt: "2026-10-03T08:00:00.000Z",
  source: { channel: "browser_extension", url: "https://docs.example.com/guide", title: "Guide" },
  ...extra
});

const session = (extra: Record<string, unknown> = {}) => ({
  tabId: 3,
  domain: "docs.example.com",
  category: "learning_candidate",
  url: "https://docs.example.com/guide",
  title: "Guide",
  transition: "link",
  startedAt: "2026-10-03T08:00:00.000Z",
  endedAt: "2026-10-03T08:05:00.000Z",
  visibleSeconds: 240,
  maxScrollDepth: 0.6,
  revisit: false,
  captured: true,
  ...extra
});

test("page_session accepts metadata with exposure summary", () => {
  const event = base("page_session", {
    session: session({
      exposure: {
        sections: [{ key: "fp:persistence", heading: "Persistence", chars: 1800, exposed_seconds: 210, coverage: 0.78 }],
        top_blocks: [{ fp: "interrupt() pauses graph execution", exposed_seconds: 45 }],
        page_coverage: 0.41
      }
    })
  });
  assert.equal(collectorEventSchema.safeParse(event).success, true);
});

test("page_session on unrelated pages must not carry URL, title or exposure", () => {
  const leaking = base("page_session", { session: session({ domain: "weibo.com", category: "unrelated" }) });
  const result = EVENT_SCHEMAS.page_session.safeParse(leaking);
  assert.equal(result.success, false);
  const paths = result.error!.issues.map((issue) => issue.path.join("."));
  assert.ok(paths.includes("session.url") && paths.includes("session.title"));

  const privateSession = base("page_session", {
    source: { channel: "browser_extension" },
    session: { domain: "weibo.com", category: "unrelated", startedAt: "2026-10-03T08:00:00.000Z", endedAt: "2026-10-03T08:01:00.000Z", visibleSeconds: 60 }
  });
  assert.equal(EVENT_SCHEMAS.page_session.safeParse(privateSession).success, true);
});

test("behaviour events validate their payloads", () => {
  assert.equal(
    EVENT_SCHEMAS.search_performed.safeParse(base("search_performed", { search: { engine: "google", query: "langgraph interrupt" } })).success,
    true
  );
  assert.equal(EVENT_SCHEMAS.search_performed.safeParse(base("search_performed", { search: { engine: "google", query: " " } })).success, false);
  assert.equal(EVENT_SCHEMAS.copy.safeParse(base("copy", { snippet: { text: "const a = 1", isCode: true } })).success, true);
  assert.equal(
    EVENT_SCHEMAS.selection.safeParse(base("selection", { snippet: { text: "x".repeat(501), isCode: false } })).success,
    false,
    "snippets are truncated to 500 chars"
  );
  assert.equal(EVENT_SCHEMAS.activity_state.safeParse(base("activity_state", { state: "idle" })).success, true);
  assert.equal(EVENT_SCHEMAS.activity_state.safeParse(base("activity_state", { state: "sleep" })).success, false);
});

test("AI answers may carry conversationId and unknown extra fields", () => {
  const answer = base("assistant_response_completed", {
    conversationId: "c-123",
    answer: { plainText: "重排是精排。", blocks: [] },
    extraField: true
  });
  assert.equal(collectorEventSchema.safeParse(answer).success, true);
});

test("batch requests are limited to 50 events", () => {
  assert.equal(eventBatchRequestSchema.safeParse({ events: Array.from({ length: MAX_BATCH_EVENTS }, () => ({})) }).success, true);
  assert.equal(eventBatchRequestSchema.safeParse({ events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ({})) }).success, false);
  assert.equal(eventBatchRequestSchema.safeParse({ events: [] }).success, false);
});
