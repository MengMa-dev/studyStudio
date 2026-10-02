import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createIngestionServer } from "../src/create-server.js";
import { MAX_BATCH_EVENTS } from "@study-studio/shared";

const token = "batch-token";
const source = { channel: "browser_extension" as const, url: "https://docs.example.com/x", title: "X" };

const base = (type: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  schemaVersion: 1,
  type,
  occurredAt: "2026-10-02T12:00:00.000Z",
  source,
  ...extra
});

async function start() {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-batch-"));
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken: token,
    disableScheduler: true,
    skipVector: true,
    memory: true
  });
  const port = await ingestion.listen(0);
  const call = async (path: string, init: RequestInit & { auth?: string | null } = {}) => {
    const { auth = token, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("content-type", "application/json");
    if (auth) headers.set("authorization", `Bearer ${auth}`);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...rest, headers });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, headers: response, etag: response.headers.get("etag") };
  };
  return {
    call,
    port,
    db: ingestion.db.db,
    async close() {
      await ingestion.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("batch sync returns per-event results and does not re-ingest duplicates", async (t) => {
  const service = await start();
  t.after(() => service.close());

  const note = base("user_note", { note: { text: "第一批备注" } });
  const page = base("webpage_captured", {
    reason: "threshold",
    content: {
      title: "X",
      canonicalUrl: "https://docs.example.com/x",
      plainText: "body ".repeat(40),
      markdown: "# X",
      contentHash: "x1",
      extractor: "defuddle",
      media: []
    }
  });
  const invalid = { ...base("user_note", { note: { text: "bad" } }), id: "!!" };

  const first = await service.call("/v1/events/batch", {
    method: "POST",
    body: JSON.stringify({ events: [note, page, invalid] })
  });
  assert.equal(first.status, 200);
  const results = (first.body as { results: { id: string | null; status: string; error?: string }[] }).results;
  assert.equal(results.length, 3);
  assert.equal(results[0]?.status, "accepted");
  assert.equal(results[1]?.status, "accepted");
  assert.equal(results[2]?.status, "rejected");
  assert.ok(results[2]?.error);

  const second = await service.call("/v1/events/batch", {
    method: "POST",
    body: JSON.stringify({ events: [note, page] })
  });
  const again = (second.body as { results: { status: string }[] }).results;
  assert.deepEqual(
    again.map((row) => row.status),
    ["duplicate", "duplicate"]
  );
  assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 2, "duplicates must not create extra rows");
  assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("batch rejects oversized event count", async (t) => {
  const service = await start();
  t.after(() => service.close());
  const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => base("activity_state", { state: "active" }));
  const response = await service.call("/v1/events/batch", { method: "POST", body: JSON.stringify({ events }) });
  assert.equal(response.status, 422);
});

test("settings ETag / If-None-Match", async (t) => {
  const service = await start();
  t.after(() => service.close());

  const first = await service.call("/v1/settings", { method: "GET" });
  assert.equal(first.status, 200);
  assert.ok(first.etag);
  assert.equal((first.body as { captureRules: { preset: string } }).captureRules.preset, "standard");

  const cached = await service.call("/v1/settings", {
    method: "GET",
    headers: { "if-none-match": first.etag! }
  });
  assert.equal(cached.status, 304);

  const updated = await service.call("/v1/settings", {
    method: "PUT",
    body: JSON.stringify({ captureRules: { preset: "debug" } })
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.etag, first.etag);
  assert.equal((updated.body as { captureRules: { minActiveSeconds: number } }).captureRules.minActiveSeconds, 5);
});

test("Host and Origin guards", async (t) => {
  const service = await start();
  t.after(() => service.close());

  // When host is the real connection host, pairing works:
  assert.equal((await service.call("/v1/pairing", { method: "GET" })).status, 200);

  // Workbench-style write without Origin and without Bearer fails.
  const noAuth = await service.call("/v1/settings", {
    method: "PUT",
    auth: null,
    body: JSON.stringify({ captureRules: { preset: "debug" } })
  });
  assert.equal(noAuth.status, 401);

  // Extension Bearer without Origin is allowed.
  const withBearer = await service.call("/v1/settings", {
    method: "PUT",
    body: JSON.stringify({ activityTracking: { retentionDays: 21 } })
  });
  assert.equal(withBearer.status, 200);
});

test("exclusion rules ignore matching events on ingest", async (t) => {
  const service = await start();
  t.after(() => service.close());

  const created = await service.call("/v1/rules", {
    method: "POST",
    body: JSON.stringify({ kind: "domain", value: "blocked.example.com", note: "test" })
  });
  assert.equal(created.status, 201);

  const blocked = await service.call("/v1/events", {
    method: "POST",
    body: JSON.stringify(
      base("webpage_captured", {
        source: { channel: "browser_extension", url: "https://blocked.example.com/a" },
        content: {
          title: "Blocked",
          canonicalUrl: "https://blocked.example.com/a",
          plainText: "x ".repeat(40),
          contentHash: "b"
        }
      })
    )
  });
  assert.equal(blocked.status, 202);
  assert.equal((blocked.body as { ignored?: boolean }).ignored, true);
  assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 0);

  const listed = await service.call("/v1/rules", { method: "GET" });
  const rules = (listed.body as { rules: { id: string }[] }).rules;
  assert.equal(rules.length, 1);
  assert.equal((await service.call(`/v1/rules/${rules[0]!.id}`, { method: "DELETE" })).status, 200);
});

test("behaviour events store metadata only and accumulate exposure", async (t) => {
  const service = await start();
  t.after(() => service.close());

  const page = await service.call("/v1/events", {
    method: "POST",
    body: JSON.stringify(
      base("webpage_captured", {
        content: {
          title: "Guide",
          canonicalUrl: "https://docs.example.com/x",
          plainText: "body ".repeat(40),
          markdown: "# Guide\n\nPersistence section",
          contentHash: "g1",
          extractor: "defuddle"
        }
      })
    )
  });
  assert.equal(page.status, 201);
  const itemId = String((page.body as { itemId: string }).itemId);

  const session = base("page_session", {
    session: {
      domain: "docs.example.com",
      category: "learning_candidate",
      url: "https://docs.example.com/x",
      title: "Guide",
      startedAt: "2026-10-02T12:00:00.000Z",
      endedAt: "2026-10-02T12:05:00.000Z",
      visibleSeconds: 240,
      exposure: {
        sections: [{ key: "fp:persistence", heading: "Persistence", chars: 1800, exposed_seconds: 100, coverage: 0.3 }],
        top_blocks: [{ fp: "interrupt() pauses", exposed_seconds: 40 }],
        page_coverage: 0.3
      }
    }
  });
  const first = await service.call("/v1/events", { method: "POST", body: JSON.stringify(session) });
  assert.equal(first.status, 201);
  assert.equal((first.body as { itemId?: string }).itemId, itemId);

  const payload = service.db.prepare("SELECT payload FROM events WHERE id = ?").get(session.id) as { payload: string };
  const parsed = JSON.parse(payload.payload);
  assert.equal(parsed.session.exposure.sections[0].exposed_seconds, 100);
  assert.equal(parsed.content, undefined, "behaviour events must not carry page bodies");

  const again = base("page_session", {
    session: {
      domain: "docs.example.com",
      category: "learning_candidate",
      url: "https://docs.example.com/x",
      title: "Guide",
      startedAt: "2026-10-02T13:00:00.000Z",
      endedAt: "2026-10-02T13:02:00.000Z",
      visibleSeconds: 90,
      exposure: {
        sections: [{ key: "fp:persistence", heading: "Persistence", chars: 1800, exposed_seconds: 50, coverage: 0.2 }],
        top_blocks: [{ fp: "interrupt() pauses", exposed_seconds: 20 }],
        page_coverage: 0.4
      }
    }
  });
  assert.equal((await service.call("/v1/events", { method: "POST", body: JSON.stringify(again) })).status, 201);

  const exposure = service.db
    .prepare("SELECT exposed_seconds, coverage FROM item_exposure WHERE item_id = ? AND section_key = ?")
    .get(itemId, "fp:persistence") as { exposed_seconds: number; coverage: number };
  assert.equal(exposure.exposed_seconds, 150);
  assert.ok(exposure.coverage > 0);

  const copy = base("copy", { snippet: { text: "const a = 1", isCode: true } });
  assert.equal((await service.call("/v1/events", { method: "POST", body: JSON.stringify(copy) })).status, 201);
  assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('page_session','copy')").get() as { n: number }).n, 3);
});

test("presence is memory-only", async (t) => {
  const service = await start();
  t.after(() => service.close());
  const post = await service.call("/v1/presence", {
    method: "POST",
    body: JSON.stringify({ title: "Guide", url: "https://docs.example.com/x", visibleSeconds: 15, captured: true })
  });
  assert.equal(post.status, 200);
  const listed = await service.call("/v1/presence", { method: "GET" });
  assert.equal((listed.body as { entries: unknown[] }).entries.length, 1);
  assert.equal((service.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
});
