import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteImpactResponseSchema,
  deleteItemsResponseSchema,
  INBOX_API,
  inboxBulkResponseSchema,
  inboxItemDetailSchema,
  inboxListResponseSchema,
  TRASH_API,
  trashListResponseSchema,
  trashPurgeResponseSchema,
  trashRestoreResponseSchema
} from "@study-studio/shared";
import { purgeExpiredTrash } from "../../src/domains/data/cleanup.js";
import { registerTrashHandler } from "../../src/domains/trash/registry.js";
import { insertTrashRow } from "../../src/domains/trash/store.js";
import { setup } from "./helpers.js";

async function seed(t: Parameters<typeof setup>[0]) {
  const ctx = await setup(t);
  const p1 = ctx.page("https://docs.example.com/hnsw", "HNSW", "2026-09-28T02:00:00.000Z", "s1");
  ctx.read("https://docs.example.com/hnsw", "2026-09-28T02:05:00.000Z", 300, "s1");
  const p2 = ctx.page("https://blog.example.org/rerank", "Rerank", "2026-09-29T02:00:00.000Z");
  const p3 = ctx.page("https://docs.example.com/bm25", "BM25", "2026-09-30T02:00:00.000Z");
  const q1 = ctx.qa("2026-09-30T05:00:00.000Z", "2026-09-30T05:01:00.000Z", "什么是交叉编码器？");
  const fuzzy = ctx.note("想搞清楚重排", "2026-09-29T12:00:00.000Z");
  const itemNote = ctx.note("HNSW 的层级", "2026-09-28T03:00:00.000Z", "https://docs.example.com/hnsw");
  return { ...ctx, p1, p2, p3, q1, fuzzy, itemNote };
}

function seedKb(db: DatabaseSync, ids: { p1: string; p2: string }) {
  const entry = db.prepare("INSERT INTO kb_entries(id, name, mastery, user_edited, updated_at) VALUES (?, ?, ?, ?, '2026-09-30T00:00:00.000Z')");
  entry.run("e-only", "HNSW", 0.2, 0);
  entry.run("e-shared", "向量检索", 0.6, 0);
  entry.run("e-edited", "分层图", null, 1);
  const source = db.prepare("INSERT INTO kb_entry_sources(entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, '[]', 'blog', '2026-09-30')");
  source.run("e-only", ids.p1);
  source.run("e-shared", ids.p1);
  source.run("e-shared", ids.p2);
  source.run("e-edited", ids.p1);
  db.prepare("INSERT INTO kb_edges(src, dst, type) VALUES ('e-only', 'e-shared', 'related')").run();
  db.prepare("INSERT INTO kb_edges(src, dst, type) VALUES ('e-shared', 'e-edited', 'contrasts')").run();
  db.prepare("INSERT INTO kb_edge_sources(src, dst, type, item_id, description) VALUES ('e-shared', 'e-edited', 'contrasts', ?, 'diff')").run(ids.p1);
  db.prepare("INSERT INTO organize_results(item_id, summary, decision) VALUES (?, 'sum', 'new')").run(ids.p1);
  db.prepare("UPDATE items SET organize_status = 'ingested' WHERE id IN (?, ?)").run(ids.p1, ids.p2);
}

const DUMP_TABLES: Record<string, string> = {
  items: "SELECT * FROM items ORDER BY id",
  item_contents: "SELECT * FROM item_contents ORDER BY item_id",
  notes: "SELECT * FROM notes ORDER BY id",
  tags: "SELECT * FROM tags ORDER BY item_id, tag",
  kb_entries: "SELECT * FROM kb_entries ORDER BY id",
  kb_entry_sources: "SELECT * FROM kb_entry_sources ORDER BY entry_id, item_id",
  kb_edges: "SELECT * FROM kb_edges ORDER BY src, dst, type",
  kb_edge_sources: "SELECT src, dst, type, item_id, description FROM kb_edge_sources ORDER BY src, dst, type, item_id",
  organize_results: "SELECT * FROM organize_results ORDER BY item_id",
  rules: "SELECT * FROM rules ORDER BY id",
  trash: "SELECT * FROM trash ORDER BY id"
};

function dump(db: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries(
    Object.entries(DUMP_TABLES).map(([name, sql]) => [
      name,
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }))
    ])
  );
}

test("inbox list: fuzzy notes interleave, filters and cursor pagination", async (t) => {
  const { call, p1, p2, p3, q1, fuzzy } = await seed(t);

  const all = inboxListResponseSchema.parse((await call("GET", INBOX_API.list)).body);
  assert.equal(all.total, 5);
  assert.deepEqual(
    all.rows.map((row) => row.id),
    [q1, p3, fuzzy, p2, p1],
    "newest first; fuzzy note placed by created_at"
  );
  assert.equal(all.nextCursor, null);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = inboxListResponseSchema.parse((await call("GET", `${INBOX_API.list}${query}`)).body);
    assert.ok(page.rows.length <= 2);
    assert.equal(page.total, 5);
    seen.push(...page.rows.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [q1, p3, fuzzy, p2, p1]);

  const webpages = inboxListResponseSchema.parse((await call("GET", `${INBOX_API.list}?type=webpage`)).body);
  assert.deepEqual(
    webpages.rows.map((row) => row.id),
    [p3, p2, p1]
  );
  const qa = inboxListResponseSchema.parse((await call("GET", `${INBOX_API.list}?type=conversation`)).body);
  assert.deepEqual(
    qa.rows.map((row) => [row.id, row.kind === "item" && row.type]),
    [[q1, "conversation"]]
  );
  const unread = inboxListResponseSchema.parse((await call("GET", `${INBOX_API.list}?status=unread`)).body);
  assert.equal(unread.total, 4, "status filter drops fuzzy notes");
  assert.ok(unread.rows.every((row) => row.kind === "item"));

  const first = unread.rows[unread.rows.length - 1]!;
  assert.equal(first.kind === "item" && first.readingTotalSeconds, 300);

  assert.equal((await call("GET", `${INBOX_API.list}?cursor=bogus`)).status, 422);
  assert.equal((await call("GET", `${INBOX_API.list}?limit=500`)).status, 422);
});

test("inbox detail, patch and bulk", async (t) => {
  const { call, db, p1, p2, q1, itemNote } = await seed(t);
  seedKb(db, { p1, p2 });

  assert.equal((await call("GET", INBOX_API.detail("missing"))).status, 404);

  const detail = inboxItemDetailSchema.parse((await call("GET", INBOX_API.detail(p1))).body);
  assert.equal(detail.readStatus, "read", "opening the detail marks it read");
  assert.equal(detail.markdown, "# HNSW\n\nbody");
  assert.equal(detail.readingSessions.length, 1);
  assert.equal(detail.readingSessions[0]!.seconds, 300);
  assert.equal(detail.readingSessions[0]!.isFirst, true);
  assert.deepEqual(
    detail.notes.map((note) => note.id),
    [itemNote]
  );
  assert.equal(detail.unusedNoteCount, 1);
  assert.deepEqual(detail.relatedEntries.map((entry) => entry.name).sort(), ["HNSW", "分层图", "向量检索"].sort());

  const conversation = inboxItemDetailSchema.parse((await call("GET", `${INBOX_API.detail(q1)}?markRead=0`)).body);
  assert.equal(conversation.question, "什么是交叉编码器？");
  assert.equal(conversation.readStatus, "unread");

  const edited = inboxItemDetailSchema.parse((await call("PATCH", INBOX_API.patch(p1), { markdown: "# 新正文", tags: ["向量", "向量", "ANN"] })).body);
  assert.equal(edited.markdown, "# 新正文");
  assert.equal(edited.dirty, true);
  assert.ok(edited.editedAt);
  assert.deepEqual(edited.tags, ["向量", "ANN"]);
  await call("PATCH", INBOX_API.patch(p1), { markdown: "# 第二次" });
  const contents = db.prepare("SELECT markdown, original_markdown FROM item_contents WHERE item_id = ?").get(p1) as Record<string, string>;
  assert.deepEqual({ ...contents }, { markdown: "# 第二次", original_markdown: "# HNSW\n\nbody" }, "first edit backs up the original once");

  assert.equal((await call("PATCH", INBOX_API.patch(p1), {})).status, 422);
  assert.equal((await call("PATCH", INBOX_API.patch("missing"), { readStatus: "read" })).status, 404);

  const bulk = inboxBulkResponseSchema.parse((await call("POST", INBOX_API.bulk, { action: "tags", ids: [p1, p2, "missing"], tags: ["RAG"] })).body);
  assert.equal(bulk.updated, 2);
  const tagged = inboxItemDetailSchema.parse((await call("GET", INBOX_API.detail(p1))).body);
  assert.deepEqual(tagged.tags, ["向量", "ANN", "RAG"]);
  await call("POST", INBOX_API.bulk, { action: "read_status", ids: [p1, p2], readStatus: "unread" });
  const unread = inboxListResponseSchema.parse((await call("GET", `${INBOX_API.list}?status=unread`)).body);
  assert.ok(unread.rows.some((row) => row.id === p1));
});

test("delete moves items to trash, updates the KB, and undo restores everything", async (t) => {
  const { call, db, p1, p2, fuzzy, itemNote } = await seed(t);
  seedKb(db, { p1, p2 });
  db.prepare("INSERT INTO tags(item_id, tag) VALUES (?, 'keep')").run(p1);

  const impact = deleteImpactResponseSchema.parse((await call("GET", `${INBOX_API.impact}?ids=${p1}&noteIds=${fuzzy}`)).body);
  assert.equal(impact.itemCount, 1);
  assert.equal(impact.noteCount, 2, "explicit fuzzy note + the item's own note");
  assert.deepEqual(
    impact.entriesToDelete.map((entry) => entry.id),
    ["e-only"]
  );
  assert.deepEqual(
    impact.entriesToStale.map((entry) => entry.id),
    ["e-shared"]
  );
  assert.deepEqual(
    impact.entriesToOrphan.map((entry) => entry.id),
    ["e-edited"]
  );
  assert.equal(impact.evidenceCount, 3);
  assert.equal((await call("GET", INBOX_API.impact)).status, 422);

  const before = dump(db);
  const deleted = deleteItemsResponseSchema.parse((await call("DELETE", INBOX_API.delete, { ids: [p1], noteIds: [fuzzy], rule: "domain" })).body);
  assert.deepEqual([deleted.deletedItemCount, deleted.deletedNoteCount], [1, 2]);

  const list = inboxListResponseSchema.parse((await call("GET", INBOX_API.list)).body);
  assert.ok(!list.rows.some((row) => row.id === p1 || row.id === fuzzy));
  assert.equal((await call("GET", INBOX_API.detail(p1))).status, 404);
  const flags = (id: string) => ({ ...(db.prepare("SELECT deleted_at IS NOT NULL AS deleted, stale, orphan FROM kb_entries WHERE id = ?").get(id) as object) });
  assert.deepEqual(flags("e-only"), { deleted: 1, stale: 0, orphan: 0 });
  assert.deepEqual(flags("e-shared"), { deleted: 0, stale: 1, orphan: 0 });
  assert.deepEqual(flags("e-edited"), { deleted: 0, stale: 0, orphan: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_entry_sources WHERE item_id = ?").get(p1)!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_edges").get()!.n, 0, "edges of deleted entries and edges backed only by the item go");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organize_results").get()!.n, 0);
  assert.deepEqual({ ...(db.prepare("SELECT kind, value FROM rules").get() as object) }, { kind: "domain", value: "docs.example.com" });

  const trash = trashListResponseSchema.parse((await call("GET", TRASH_API.list)).body);
  assert.equal(trash.entries.length, 1);
  const entry = trash.entries[0]!;
  assert.equal(entry.id, deleted.trashId);
  assert.equal(entry.kind, "mixed");
  assert.equal(entry.removeFromKb, true);
  assert.equal(entry.removedEntryCount, 1);
  assert.deepEqual(entry.itemIds, [p1]);
  assert.deepEqual(entry.noteIds.sort(), [fuzzy, itemNote].sort());
  assert.equal(entry.itemType, "webpage");

  const restored = trashRestoreResponseSchema.parse((await call("POST", TRASH_API.restore(deleted.trashId))).body);
  assert.deepEqual(restored, { restoredItemCount: 1, restoredNoteCount: 2, restoredEntryCount: 0 });
  assert.deepEqual(dump(db), before, "undo rolls every table back");
  assert.equal((await call("POST", TRASH_API.restore(deleted.trashId))).status, 404);
});

test("purge removes trashed rows physically; restore conflicts when the page was recaptured", async (t) => {
  const { call, db, page, p1, p3 } = await seed(t);

  const keepKb = deleteItemsResponseSchema.parse((await call("DELETE", INBOX_API.delete, { ids: [p3], removeFromKb: false })).body);
  const trash = trashListResponseSchema.parse((await call("GET", TRASH_API.list)).body);
  assert.equal(trash.entries[0]!.kind, "items");
  assert.equal(trash.entries[0]!.removeFromKb, false);
  trashPurgeResponseSchema.parse((await call("DELETE", TRASH_API.purge(keepKb.trashId))).body);
  for (const table of ["items", "item_contents", "events"]) {
    const column = table === "items" ? "id" : "item_id";
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(p3)!.n, 0, `${table} purged`);
  }
  assert.equal((await call("DELETE", TRASH_API.purge(keepKb.trashId))).status, 404);

  const second = deleteItemsResponseSchema.parse((await call("DELETE", INBOX_API.delete, { ids: [p1] })).body);
  page("https://docs.example.com/hnsw", "HNSW again", "2026-10-01T02:00:00.000Z");
  assert.equal((await call("POST", TRASH_API.restore(second.trashId))).status, 409);

  assert.equal((await call("DELETE", INBOX_API.delete, { ids: ["missing"] })).status, 404);
});

test("expired trash is purged by the scheduler cleanup", async (t) => {
  const { call, db, p2 } = await seed(t);
  deleteItemsResponseSchema.parse((await call("DELETE", INBOX_API.delete, { ids: [p2] })).body);
  assert.equal(purgeExpiredTrash(db, null, new Date()), 0);
  assert.equal(purgeExpiredTrash(db, null, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE id = ?").get(p2)!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trash").get()!.n, 0);
});

test("entries trash rows go through the registered handler, 501 otherwise", async (t) => {
  const { call, db } = await seed(t);
  const record = insertTrashRow(db, {
    kind: "entries",
    targets: { entryIds: ["e1", "e2"] },
    meta: { title: "HNSW 等 2 项", site: null, itemType: null, removeFromKb: true, removedEntryCount: 2 },
    payload: { anything: true }
  });
  const listed = trashListResponseSchema.parse((await call("GET", TRASH_API.list)).body);
  assert.deepEqual(listed.entries[0]!.entryIds, ["e1", "e2"]);

  assert.equal((await call("POST", TRASH_API.restore(record.id))).status, 501);
  assert.equal((await call("DELETE", TRASH_API.purge(record.id))).status, 501);

  const seen: string[] = [];
  const unregister = registerTrashHandler("entries", {
    restore: async (_ctx, row) => {
      seen.push(`restore:${row.targets.entryIds.join(",")}`);
      return { restoredEntryCount: row.targets.entryIds.length };
    },
    purge: (_ctx, row) => {
      seen.push(`purge:${row.id}`);
    }
  });
  t.after(unregister);
  const restored = trashRestoreResponseSchema.parse((await call("POST", TRASH_API.restore(record.id))).body);
  assert.deepEqual(restored, { restoredItemCount: 0, restoredNoteCount: 0, restoredEntryCount: 2 });
  assert.deepEqual(seen, ["restore:e1,e2"]);
  assert.equal(trashListResponseSchema.parse((await call("GET", TRASH_API.list)).body).entries.length, 0);
});
