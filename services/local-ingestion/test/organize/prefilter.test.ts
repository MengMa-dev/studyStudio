import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSimhash, prefilterItem, recencyWeight, scoreRelatedEntry } from "../../src/domains/organize/index.js";

const BODY = `# Human-in-the-loop

interrupt() pauses graph execution and surfaces a value to the client.
Resuming requires a checkpointer so the run can continue from the saved checkpoint.
This section explains why HITL depends on persistent state across super-steps, and how
MemorySaver, SqliteSaver and PostgresSaver differ in production.

## Implementation

Use interrupt inside a node, then resume with Command(resume=...).
`;

test("④ recency weight decays with halfLife and floors", () => {
  const now = "2026-10-02";
  const w0 = recencyWeight("2026-10-02", now);
  assert.ok(w0 >= 0.99);
  const w21 = recencyWeight("2026-09-11", now);
  assert.ok(Math.abs(w21 - 0.5) < 0.02);
  const wOld = recencyWeight("2020-01-01", now);
  assert.equal(wOld, 0.3);
  const scored = scoreRelatedEntry({ entry_id: "kb_1", name: "HITL", similarity: 0.8, last_source_at: "2026-09-11" }, now);
  assert.ok(Math.abs(scored.recency_relevance - 0.8 * w21) < 0.01);
});

test("④ kb_ignore rejects by title", () => {
  const result = prefilterItem({
    item: {
      item_id: "item_1",
      title: "临时笔记",
      plain_text: BODY,
      markdown: BODY,
      has_note: false,
      has_highlight: false
    },
    related_candidates: [],
    kb_ignore_names: ["临时笔记"]
  });
  assert.equal(result.route, "prefilter:kb_ignore");
  assert.equal(result.decision, "reject");
  if (result.decision === "reject") assert.equal(result.reject_reason, "ignored");
});

test("④ SimHash / content_hash near-duplicate → duplicate", () => {
  const hash = computeSimhash(BODY);
  const byHash = prefilterItem({
    item: {
      item_id: "item_2",
      title: "HITL",
      content_hash: "abc123",
      markdown: BODY,
      has_note: false,
      has_highlight: false
    },
    related_candidates: [],
    source_fingerprints: [{ entry_id: "kb_hitl", content_hash: "abc123", simhash: hash }],
    kb_ignore_names: []
  });
  assert.equal(byHash.route, "prefilter:simhash_duplicate");
  assert.equal(byHash.decision, "duplicate");

  const bySim = prefilterItem({
    item: {
      item_id: "item_3",
      title: "HITL again",
      markdown: BODY + "\n\nminor trailing note.",
      has_note: false,
      has_highlight: false
    },
    related_candidates: [],
    source_fingerprints: [{ entry_id: "kb_hitl", simhash: hash }],
    kb_ignore_names: []
  });
  assert.equal(bySim.route, "prefilter:simhash_duplicate");
  assert.equal(bySim.decision, "duplicate");
});

test("④ high similarity without note/highlight → duplicate; with note → llm", () => {
  const candidates = [
    {
      entry_id: "kb_hitl",
      name: "Human-in-the-loop",
      similarity: 0.95,
      last_source_at: "2026-09-26",
      summary: "HITL"
    }
  ];
  const dup = prefilterItem({
    item: { item_id: "a", title: "HITL", markdown: BODY, has_note: false, has_highlight: false },
    related_candidates: candidates,
    kb_ignore_names: []
  });
  assert.equal(dup.route, "prefilter:similarity_duplicate");
  assert.equal(dup.decision, "duplicate");

  const pass = prefilterItem({
    item: { item_id: "b", title: "HITL", markdown: BODY, has_note: true, has_highlight: false },
    related_candidates: candidates,
    kb_ignore_names: []
  });
  assert.equal(pass.route, "llm");
});

test("④ navigational / low_information reject; note兜底", () => {
  const listing = prefilterItem({
    item: {
      item_id: "list",
      title: "Search",
      url: "https://example.com/search?q=langgraph",
      markdown: BODY,
      has_note: false,
      has_highlight: false
    },
    related_candidates: [],
    kb_ignore_names: []
  });
  assert.equal(listing.route, "prefilter:navigational");
  assert.equal(listing.decision, "reject");
  assert.equal(listing.reject_reason, "navigational");

  const short = prefilterItem({
    item: {
      item_id: "short",
      title: "Hi",
      markdown: "太短了",
      has_note: false,
      has_highlight: false
    },
    related_candidates: [],
    kb_ignore_names: []
  });
  assert.equal(short.route, "prefilter:low_information");
  assert.equal(short.decision, "reject");
  assert.equal(short.reject_reason, "low_information");

  const protectedShort = prefilterItem({
    item: {
      item_id: "short2",
      title: "Hi",
      markdown: "太短了",
      has_note: false,
      has_highlight: true
    },
    related_candidates: [],
    kb_ignore_names: []
  });
  assert.equal(protectedShort.route, "llm");
});

test("④ drops related entries below 0.55 and keeps top-5", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    entry_id: `kb_${i}`,
    name: `E${i}`,
    similarity: 0.5 + i * 0.05,
    last_source_at: "2026-09-01"
  }));
  const result = prefilterItem({
    item: { item_id: "x", title: "doc", markdown: BODY, has_note: false, has_highlight: false },
    related_candidates: candidates,
    kb_ignore_names: []
  });
  assert.equal(result.route, "llm");
  assert.ok(result.related_entries.every((e) => e.similarity >= 0.55));
  assert.ok(result.related_entries.length <= 5);
  assert.equal(result.related_entries[0]?.entry_id, "kb_7");
});
