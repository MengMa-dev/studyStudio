import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deterministicEmbedding } from "../../src/ai/mock";
import { chunkText, estimateTokens } from "../../src/search/chunk";
import { buildFtsQueryPlan, searchFts } from "../../src/search/fts";
import { hybridSearch } from "../../src/search/hybrid";
import { applySearchMigration, createSearchIndex } from "../../src/search/index-api";
import { queryCharLength, segmentText } from "../../src/search/segment";
import { ensureVectorStore } from "../../src/search/vectors";

const migrationFile = join(dirname(fileURLToPath(import.meta.url)), "../../src/migrations/002_search.sql");

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

test("002_search.sql creates chunks + fts + trigram (not vec)", () => {
  const db = openDb();
  const sql = readFileSync(migrationFile, "utf8");
  db.exec(sql);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name").all() as {
    name: string;
  }[];
  const names = tables.map((t) => t.name);
  assert.ok(names.includes("chunks"));
  assert.ok(names.includes("chunks_fts"));
  assert.ok(names.includes("chunks_trigram"));
  assert.equal(names.includes("chunks_vec"), false);
  applySearchMigration(db); // idempotent
  db.close();
});

test("Segmenter presegmentation produces searchable tokens", () => {
  const seg = segmentText("交叉编码器用于重排");
  assert.ok(seg.length > 0);
  assert.ok(queryCharLength("重排") < 3);
  assert.ok(queryCharLength("checkpoint") >= 3);
});

test("Chinese and English keyword + vector hybrid recall", async () => {
  const db = openDb();
  const index = createSearchIndex(db, { forceMemory: true, dimensions: 32 });
  const docs = [
    { ownerType: "entry", ownerId: "e1", text: "交叉编码器用于重排阶段，对召回的候选文档精排" },
    { ownerType: "entry", ownerId: "e2", text: "LangGraph interrupt depends on checkpoint persistence for human-in-the-loop" },
    { ownerType: "entry", ownerId: "e3", text: "向量召回使用 embedding 相似度从大规模语料中粗筛" }
  ];

  for (const doc of docs) {
    const parts = chunkText(doc.text, { targetTokens: 200 });
    const vectors = parts.map((part) => deterministicEmbedding(part.text, 32));
    await index.indexDocument(doc, vectors);
  }

  assert.ok(segmentText("交叉编码器").includes("交叉") || segmentText("交叉编码器").length > 0);
  assert.ok(queryCharLength("重排") < 3);

  const planShort = buildFtsQueryPlan("重排");
  assert.equal(planShort.shortQuery, true);
  assert.ok(planShort.like);

  // Keyword: Chinese professional term via phrase or fallback
  const ftsZh = searchFts(db, "交叉编码器", { limit: 5 });
  assert.ok(
    ftsZh.some((hit) => hit.ownerId === "e1"),
    `expected e1 in ${JSON.stringify(ftsZh)}`
  );

  // Short query fallback
  const ftsShort = searchFts(db, "重排", { limit: 5 });
  assert.ok(
    ftsShort.some((hit) => hit.ownerId === "e1"),
    "short query 重排 should hit via like/trigram"
  );

  // English keyword
  const ftsEn = searchFts(db, "checkpoint", { limit: 5 });
  assert.ok(ftsEn.some((hit) => hit.ownerId === "e2"));

  // Vector recall
  const qEmbed = deterministicEmbedding("交叉编码器 重排", 32);
  const vectorHits = index.vectorStore.search(qEmbed, 3);
  assert.ok(vectorHits.length > 0);

  const hybrid = hybridSearch(
    db,
    index.vectorStore,
    { text: "checkpoint persistence", embedding: deterministicEmbedding("checkpoint persistence", 32) },
    { limit: 5, ownerType: "entry" }
  );
  assert.ok(
    hybrid.some((hit) => hit.ownerId === "e2"),
    `hybrid should recall e2: ${JSON.stringify(hybrid)}`
  );
  assert.ok(hybrid.some((hit) => hit.sources.includes("fts") || hit.sources.includes("vector")));
});

test("vector store falls back to memory when sqlite-vec load fails", () => {
  const db = openDb();
  applySearchMigration(db);
  const store = ensureVectorStore(db, {
    dimensions: 4,
    extensionPath: "/nonexistent/vec0.so"
  });
  assert.equal(store.backend, "memory");
  store.upsert(1, [1, 0, 0, 0]);
  store.upsert(2, [0, 1, 0, 0]);
  const hits = store.search([0.9, 0.1, 0, 0], 1);
  assert.equal(hits[0]?.rowid, 1);
});

test("sqlite-vec backend works when extension loads", () => {
  const db = openDb();
  applySearchMigration(db);
  const store = ensureVectorStore(db, { dimensions: 4 });
  assert.equal(store.backend, "sqlite-vec");
  store.upsert(1, [1, 0, 0, 0]);
  store.upsert(2, [0.9, 0.1, 0, 0]);
  const hits = store.search([1, 0.05, 0, 0], 2);
  assert.deepEqual(
    hits.map((h) => h.rowid),
    [1, 2]
  );
});

test("reindex reports progress and rebuilds FTS + vectors", async () => {
  const db = openDb();
  const index = createSearchIndex(db, { forceMemory: true, dimensions: 16 });
  const progress: string[] = [];
  await index.reindex(
    [
      { ownerType: "entry", ownerId: "a", text: "第一段关于精排与重排" },
      { ownerType: "entry", ownerId: "b", text: "第二段 embedding 向量召回" }
    ],
    (text) => deterministicEmbedding(text, 16),
    (p) => progress.push(`${p.phase}:${p.done}/${p.total}`)
  );
  assert.ok(progress.some((line) => line.startsWith("done:")));
  assert.ok(index.vectorStore.size() >= 2);
  const hits = searchFts(db, "精排");
  assert.ok(hits.some((hit) => hit.ownerId === "a"));
  assert.ok(estimateTokens("交叉编码器") >= 4);
});
