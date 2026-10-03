import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KB_REWRITE_SUGGEST_PATCH_COUNT,
  kbDeleteImpactResponseSchema,
  kbEntryDetailSchema,
  kbTreeResponseSchema,
  type KbTreeEntryNode
} from "@study-studio/shared";
import type { TrashRow } from "../../src/db/types.js";
import {
  deleteKbEntries,
  estimateMastery,
  getKbDeleteImpact,
  getKbEntryDetail,
  getKbTree,
  kbTrashHandler,
  createKbTrashHandler,
  patchKbEntry,
  recomputeAutoMastery,
  stripSuggestionSection,
  type KbSearchIndex
} from "../../src/domains/kb/index.js";
import { seedKb } from "./seed.js";

function names(nodes: KbTreeEntryNode[]): unknown[] {
  return nodes.map((node) => (node.children.length ? { [node.name]: names(node.children) } : node.name));
}

function fakeIndex() {
  const indexed: { ownerType: string; ownerId: string; text: string }[] = [];
  const deleted: string[] = [];
  const index: KbSearchIndex = {
    indexDocument: async (doc) => {
      indexed.push(doc);
    },
    deleteOwner: (_type, id) => {
      deleted.push(id);
    }
  };
  return { index, indexed, deleted };
}

test("tree: categories with recursive part_of nesting, markers and category stats", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const tree = kbTreeResponseSchema.parse(getKbTree(appDb.db));
  assert.equal(tree.mode, "tree");
  assert.equal(tree.total, 6);
  assert.deepEqual(
    tree.categories.map((c) => [c.id, c.name, c.entryCount]),
    [
      ["cat-rag", "RAG", 4],
      ["cat-agent", "Agent", 1],
      [null, "未分类", 1]
    ]
  );
  const rag = tree.categories[0]!;
  assert.deepEqual(names(rag.children), [{ "RAG 系统": [{ 重排: ["交叉编码器", "双塔编码器"] }] }]);

  const rerank = rag.children[0]!.children[0]!;
  assert.equal(rerank.sourceCount, 2);
  assert.equal(rerank.orphan, false);
  const cross = rerank.children[0]!;
  assert.equal(cross.mastery, 0.8);
  assert.equal(cross.masterySource, "user");
  assert.equal(cross.userEdited, true);

  const agent = tree.categories[1]!.children[0]!;
  assert.equal(agent.kind, "other");
  assert.equal(agent.stale, true);
  assert.equal(agent.orphan, true);
  assert.equal(agent.mastery, 0.5, "no sources keeps the stored value");

  const misc = tree.categories[2]!.children[0]!;
  assert.equal(misc.orphan, true, "deleted source items do not count");
  assert.equal(misc.sourceCount, 0);
  assert.equal(misc.mastery, null);

  assert.ok(rag.avgMastery !== null && rag.avgMastery > 0 && rag.avgMastery < 1);
  assert.ok(rag.weakEntryCount >= 1);
});

test("tree: part_of cycles and cross-category parents fall back to roots", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  appDb.db.prepare("INSERT INTO kb_edges (src, dst, type) VALUES ('kb-rag', 'kb-cross', 'part_of'), ('kb-agent', 'kb-rag', 'part_of')").run();
  const tree = getKbTree(appDb.db);
  const all = (nodes: KbTreeEntryNode[]): string[] => nodes.flatMap((node) => [node.id, ...all(node.children)]);
  const ids = tree.categories.flatMap((category) => all(category.children));
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.deepEqual(
    tree.categories[1]!.children.map((node) => node.id),
    ["kb-agent"]
  );
});

test("tree: q / kind switch to flat mode", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const byAlias = kbTreeResponseSchema.parse(getKbTree(appDb.db, { q: "检索增强" }));
  assert.equal(byAlias.mode, "flat");
  assert.deepEqual(
    byAlias.entries.map((e) => e.id),
    ["kb-rag"]
  );
  assert.equal(byAlias.entries[0]!.categoryName, "RAG");
  assert.deepEqual(
    getKbTree(appDb.db, { q: "cross-ENCODER" }).entries.map((e) => e.id),
    ["kb-cross"]
  );
  const models = getKbTree(appDb.db, { kind: "model" });
  assert.deepEqual(models.entries.map((e) => e.id).sort(), ["kb-bi", "kb-cross"]);
  assert.equal(models.total, 2);
  const misc = getKbTree(appDb.db, { kind: "paper" }).entries[0]!;
  assert.equal(misc.categoryId, null);
  assert.equal(misc.categoryName, null);
  assert.equal(getKbTree(appDb.db, { q: "已删除" }).total, 0);
});

test("detail: body, notes, sources/evidence, relations with direction, same category, completeness", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const detail = kbEntryDetailSchema.parse(getKbEntryDetail(appDb.db, "kb-rerank"));
  assert.deepEqual(
    detail.breadcrumb.map((b) => [b.type, b.id, b.name]),
    [
      ["category", "cat-rag", "RAG"],
      ["entry", "kb-rag", "RAG 系统"],
      ["entry", "kb-rerank", "重排"]
    ]
  );
  assert.equal(detail.kind, "method");
  assert.match(detail.bodyMarkdown, /## 定义/);
  assert.deepEqual(detail.completeness, { covered: ["定义"], missing: ["评估"] });
  assert.equal(detail.patchCount, 9);
  assert.ok(detail.patchCount >= KB_REWRITE_SUGGEST_PATCH_COUNT);
  assert.equal(detail.suggestRewrite, true);
  assert.deepEqual(
    detail.notes.map((n) => [n.id, n.scope, n.targetId]),
    [["note-entry", "entry", "kb-rerank"]]
  );
  assert.deepEqual(
    detail.sources.map((s) => [s.itemId, s.sourceKind, s.type]),
    [
      ["item-b", "official_doc", "webpage"],
      ["item-a", "blog", "webpage"]
    ]
  );
  assert.deepEqual(detail.sources[0]!.evidence, [{ quote: "交叉编码器精度更高" }]);
  assert.deepEqual(detail.relations.map((r) => [r.id, r.type, r.direction]).sort(), [
    ["kb-agent", "related", "out"],
    ["kb-bi", "part_of", "in"],
    ["kb-cross", "part_of", "in"],
    ["kb-rag", "part_of", "out"]
  ]);
  assert.equal(detail.relations.find((r) => r.id === "kb-cross")!.mastery, 0.8);
  assert.deepEqual(detail.sameCategory.map((e) => e.id).sort(), ["kb-bi", "kb-cross", "kb-rag"]);
  assert.equal(detail.masterySource, "auto");
  assert.equal(detail.mastery, estimateMastery({ sourceCount: 2, readingSeconds: 1800, qaCount: 0, noteCount: 2 }, null));
  assert.equal(detail.renderedSections.contrasts.length, 0);
  assert.equal(detail.orphan, false);
  assert.equal(detail.dirty, false);
});

test("detail: rendered contrasts / faqs, unknown entry → null", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const cross = kbEntryDetailSchema.parse(getKbEntryDetail(appDb.db, "kb-cross"));
  assert.deepEqual(cross.renderedSections.contrasts, [
    { entryId: "kb-bi", name: "双塔编码器", description: "交叉编码器联合编码，精度高但慢；双塔可预计算，快。", sourceItemIds: ["item-q"] }
  ]);
  assert.deepEqual(cross.renderedSections.faqs, [{ question: "交叉编码器和双塔有什么区别？", itemId: "item-q", turnItemId: "item-q" }]);
  assert.deepEqual(cross.sources[0]!.evidence, [{ quote: "交叉编码器同时编码 query 和文档", question: "交叉编码器和双塔有什么区别？", turnItemId: "item-q" }]);
  assert.equal(cross.breadcrumb.length, 4);

  const bi = getKbEntryDetail(appDb.db, "kb-bi")!;
  assert.equal(bi.renderedSections.contrasts[0]!.entryId, "kb-cross", "contrasts render on both ends");
  assert.equal(bi.renderedSections.faqs[0]!.turnItemId, null);
  assert.ok(!bi.bodyMarkdown.includes("区别"), "rendered sections are not stored in the body");

  const misc = kbEntryDetailSchema.parse(getKbEntryDetail(appDb.db, "kb-misc"));
  assert.deepEqual(misc.breadcrumb[0], { type: "category", id: null, name: "未分类" });
  assert.equal(misc.orphan, true);
  assert.deepEqual(misc.sources, []);
  assert.deepEqual(misc.sameCategory, []);

  assert.equal(getKbEntryDetail(appDb.db, "kb-gone"), null);
  assert.equal(getKbEntryDetail(appDb.db, "missing"), null);
});

test("patch: body sets user_edited + dirty, clears 整理建议, updates search index", async (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const { index, indexed } = fakeIndex();
  const body = "## 定义\n\n新的正文。\n\n## 整理建议\n\n### 追加到 ## 定义\n\n建议内容\n\n## 参考\n\n- a\n";
  const result = await patchKbEntry(appDb.db, "kb-rerank", { bodyMarkdown: body }, { searchIndex: index });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.detail.userEdited, true);
  assert.equal(result.detail.dirty, true);
  assert.equal(result.detail.bodyMarkdown, "## 定义\n\n新的正文。\n\n## 参考\n\n- a\n");
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]!.ownerType, "entry");
  assert.equal(indexed[0]!.ownerId, "kb-rerank");
  assert.match(indexed[0]!.text, /新的正文/);
  const row = appDb.db.prepare("SELECT user_edited, dirty FROM kb_entries WHERE id = 'kb-rerank'").get() as { user_edited: number; dirty: number };
  assert.deepEqual({ ...row }, { user_edited: 1, dirty: 1 });
});

test("patch: manual mastery, null restores auto, category change, errors", async (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const { index, indexed } = fakeIndex();
  const manual = await patchKbEntry(appDb.db, "kb-rag", { mastery: 0.95 }, { searchIndex: index });
  assert.ok(manual.status === "ok" && manual.detail.mastery === 0.95 && manual.detail.masterySource === "user");
  assert.equal(indexed.length, 0, "only body edits touch the index");
  assert.equal(manual.status === "ok" && manual.detail.userEdited, false);
  assert.equal(getKbTree(appDb.db).categories[0]!.children[0]!.mastery, 0.95);

  const auto = await patchKbEntry(appDb.db, "kb-rag", { mastery: null });
  const expected = estimateMastery({ sourceCount: 1, readingSeconds: 1200, qaCount: 0, noteCount: 1 }, null);
  assert.ok(auto.status === "ok" && auto.detail.masterySource === "auto" && auto.detail.mastery === expected);
  const stored = appDb.db.prepare("SELECT mastery, mastery_source FROM kb_entries WHERE id = 'kb-rag'").get() as { mastery: number; mastery_source: string };
  assert.deepEqual({ ...stored }, { mastery: expected, mastery_source: "auto" });

  const moved = await patchKbEntry(appDb.db, "kb-misc", { categoryId: "cat-agent" });
  assert.ok(moved.status === "ok" && moved.detail.categoryName === "Agent");
  const cleared = await patchKbEntry(appDb.db, "kb-misc", { categoryId: null });
  assert.ok(cleared.status === "ok" && cleared.detail.categoryId === null);

  assert.equal((await patchKbEntry(appDb.db, "kb-misc", { categoryId: "nope" })).status, "category_not_found");
  assert.equal((await patchKbEntry(appDb.db, "kb-gone", { mastery: 0.1 })).status, "not_found");
});

test("recomputeAutoMastery persists auto values and skips user entries", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  recomputeAutoMastery(appDb.db);
  const rows = Object.fromEntries(
    (appDb.db.prepare("SELECT id, mastery FROM kb_entries").all() as { id: string; mastery: number | null }[]).map((r) => [r.id, r.mastery])
  );
  assert.equal(rows["kb-cross"], 0.8);
  assert.equal(rows["kb-agent"], 0.5);
  assert.equal(rows["kb-rag"], getKbEntryDetail(appDb.db, "kb-rag")!.mastery);
  assert.equal(recomputeAutoMastery(appDb.db), 0, "idempotent");
});

test("stripSuggestionSection leaves bodies without the section untouched", () => {
  const body = "## 定义\n\nx\n";
  assert.equal(stripSuggestionSection(body), body);
  assert.equal(stripSuggestionSection("## 整理建议\n\n- a\n"), "");
});

test("delete impact: notes, relations, reparented children, source items", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const impact = kbDeleteImpactResponseSchema.parse(getKbDeleteImpact(appDb.db, ["kb-rerank", "missing"]));
  assert.deepEqual(impact.entries, [{ id: "kb-rerank", name: "重排" }]);
  assert.equal(impact.noteCount, 1);
  assert.equal(impact.relationCount, 4);
  assert.equal(impact.sourceItemCount, 2);
  assert.deepEqual(impact.reparentedChildren, [
    { id: "kb-cross", name: "交叉编码器", newParentId: "kb-rag", newParentName: "RAG 系统" },
    { id: "kb-bi", name: "双塔编码器", newParentId: "kb-rag", newParentName: "RAG 系统" }
  ]);

  const chain = getKbDeleteImpact(appDb.db, ["kb-rag", "kb-rerank"])!;
  assert.deepEqual(
    chain.reparentedChildren.map((c) => [c.id, c.newParentId]),
    [
      ["kb-cross", null],
      ["kb-bi", null]
    ]
  );
  assert.equal(getKbDeleteImpact(appDb.db, ["missing"]), null);
});

function snapshotState(appDb: ReturnType<typeof seedKb>) {
  const db = appDb.db;
  return {
    tree: getKbTree(db),
    details: ["kb-rag", "kb-rerank", "kb-cross", "kb-bi", "kb-agent", "kb-misc"].map((id) => getKbEntryDetail(db, id)),
    edges: db.prepare("SELECT * FROM kb_edges ORDER BY src, dst, type").all(),
    edgeSources: db.prepare("SELECT * FROM kb_edge_sources ORDER BY src, dst, type, item_id").all(),
    sources: db.prepare("SELECT * FROM kb_entry_sources ORDER BY entry_id, item_id").all(),
    notes: db.prepare("SELECT * FROM notes ORDER BY id").all(),
    entries: db.prepare("SELECT * FROM kb_entries ORDER BY id").all(),
    ignore: db.prepare("SELECT * FROM kb_ignore").all()
  };
}

test("delete → trash snapshot → restore brings everything back; kb_ignore is written and undone", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const db = appDb.db;
  const before = snapshotState(appDb);
  const { index, deleted } = fakeIndex();
  const now = new Date("2026-10-03T08:00:00.000Z");

  const result = deleteKbEntries(db, { ids: ["kb-rerank", "kb-rerank"], ignore: true }, { searchIndex: index, now })!;
  assert.equal(result.deletedEntryCount, 1);
  assert.deepEqual(deleted, ["kb-rerank"]);

  assert.equal(getKbEntryDetail(db, "kb-rerank"), null);
  const tree = getKbTree(db);
  assert.deepEqual(names(tree.categories[0]!.children), [{ "RAG 系统": ["交叉编码器", "双塔编码器"] }]);
  assert.equal(tree.total, 5);
  assert.deepEqual(
    (db.prepare("SELECT name FROM kb_ignore").all() as { name: string }[]).map((r) => r.name),
    ["重排"]
  );
  const note = db.prepare("SELECT deleted_at FROM notes WHERE id = 'note-entry'").get() as { deleted_at: string };
  assert.equal(note.deleted_at, now.toISOString());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kb_edges WHERE src = 'kb-rerank' OR dst = 'kb-rerank'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kb_entry_sources WHERE entry_id = 'kb-rerank'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL").get() as { n: number }).n, 3, "source items stay");

  const trash = db.prepare("SELECT * FROM trash WHERE id = ?").get(result.trashId) as TrashRow;
  assert.equal(trash.kind, "entries");
  assert.deepEqual(JSON.parse(trash.target_ids!), { itemIds: [], noteIds: [], entryIds: ["kb-rerank"] });
  assert.equal(trash.expires_at, "2026-11-02T08:00:00.000Z");
  const stored = JSON.parse(trash.snapshot!);
  assert.equal(stored.meta.title, "重排");
  const snapshot = stored.payload;
  assert.equal(snapshot.title, "重排");
  assert.equal(snapshot.edges.length, 4);
  assert.equal(snapshot.entrySources.length, 2);
  assert.equal(snapshot.reparentEdges.length, 2);

  const restored = kbTrashHandler.restore(db, trash);
  assert.deepEqual(restored, { restoredItemCount: 0, restoredNoteCount: 1, restoredEntryCount: 1 });
  assert.deepEqual(snapshotState(appDb), before);
});

test("restore keeps notes the user deleted later, nests inside an outer transaction, and reindexes", async (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const db = appDb.db;
  const { index, indexed } = fakeIndex();
  const result = deleteKbEntries(db, { ids: ["kb-cross", "kb-bi"], ignore: false })!;
  assert.equal(result.deletedEntryCount, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM kb_ignore").get() as { n: number }).n, 0);
  const trash = db.prepare("SELECT * FROM trash WHERE id = ?").get(result.trashId) as TrashRow;
  assert.equal(JSON.parse(trash.snapshot!).meta.title, "交叉编码器 等 2 个知识点");

  db.exec("BEGIN");
  createKbTrashHandler({ searchIndex: index }).restore(db, trash);
  db.exec("COMMIT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(indexed.map((d) => d.ownerId).sort(), ["kb-bi", "kb-cross"]);
  assert.equal(getKbEntryDetail(db, "kb-cross")!.renderedSections.contrasts.length, 1);
});

test("purge removes soft-deleted rows only", (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const db = appDb.db;
  const first = deleteKbEntries(db, { ids: ["kb-rerank"], ignore: false })!;
  const trash = db.prepare("SELECT * FROM trash WHERE id = ?").get(first.trashId) as TrashRow;
  kbTrashHandler.purge(db, trash);
  assert.equal(db.prepare("SELECT 1 FROM kb_entries WHERE id = 'kb-rerank'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM notes WHERE id = 'note-entry'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM kb_edges WHERE src = 'kb-cross' AND dst = 'kb-rag'").get() !== undefined, true, "reparent edge survives");

  const second = deleteKbEntries(db, { ids: ["kb-agent"], ignore: false })!;
  const trash2 = db.prepare("SELECT * FROM trash WHERE id = ?").get(second.trashId) as TrashRow;
  kbTrashHandler.restore(db, trash2);
  kbTrashHandler.purge(db, trash2);
  assert.ok(getKbEntryDetail(db, "kb-agent"), "restored entry survives a stale purge");
  assert.equal(deleteKbEntries(db, { ids: ["kb-gone"], ignore: false }), null);
});
