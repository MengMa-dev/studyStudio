import type { DatabaseSync } from "node:sqlite";
import { openDatabase, type AppDatabase } from "../../src/db/database.js";

type EntrySeed = {
  id: string;
  name: string;
  category?: string | null;
  kind?: string;
  aliases?: string[];
  summary?: string;
  body?: string;
  completeness?: unknown;
  mastery?: number | null;
  masterySource?: "auto" | "user";
  userEdited?: boolean;
  stale?: boolean;
  orphan?: boolean;
  patchCount?: number;
  deleted?: boolean;
};

function insertEntry(db: DatabaseSync, e: EntrySeed): void {
  db.prepare(
    `INSERT INTO kb_entries (id, name, category_id, kind, aliases, summary, body_markdown, completeness, mastery, mastery_source, user_edited, stale, orphan, patch_count, dirty, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-10-01T00:00:00.000Z', ?)`
  ).run(
    e.id,
    e.name,
    e.category ?? null,
    e.kind ?? "concept",
    JSON.stringify(e.aliases ?? []),
    e.summary ?? `${e.name} 简介`,
    e.body ?? `## 定义\n\n${e.name} 的正文。\n`,
    e.completeness === undefined ? null : JSON.stringify(e.completeness),
    e.mastery ?? null,
    e.masterySource ?? "auto",
    e.userEdited ? 1 : 0,
    e.stale ? 1 : 0,
    e.orphan ? 1 : 0,
    e.patchCount ?? 0,
    e.deleted ? "2026-09-30T00:00:00.000Z" : null
  );
}

function insertItem(db: DatabaseSync, id: string, type: "webpage" | "conversation", title: string, seconds: number, deleted = false): void {
  db.prepare(
    `INSERT INTO items (id, type, title, url, site, captured_at, reading_total_seconds, deleted_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-20T00:00:00.000Z', ?, ?)`
  ).run(
    id,
    type,
    title,
    `https://example.com/${id}`,
    type === "conversation" ? "ChatGPT" : "example.com",
    seconds,
    deleted ? "2026-09-25T00:00:00.000Z" : null
  );
}

function insertSource(db: DatabaseSync, entryId: string, itemId: string, evidence: unknown[], sourceKind: string, addedAt: string): void {
  db.prepare("INSERT INTO kb_entry_sources (entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, ?, ?)").run(
    entryId,
    itemId,
    JSON.stringify(evidence),
    sourceKind,
    addedAt
  );
}

function insertEdge(db: DatabaseSync, src: string, dst: string, type: string, itemId: string | null = null, description: string | null = null): void {
  db.prepare("INSERT INTO kb_edges (src, dst, type) VALUES (?, ?, ?)").run(src, dst, type);
  if (itemId || description) {
    db.prepare("INSERT INTO kb_edge_sources (src, dst, type, item_id, description) VALUES (?, ?, ?, ?, ?)").run(src, dst, type, itemId, description);
  }
}

function insertNote(db: DatabaseSync, id: string, scope: "entry" | "item", targetId: string, text: string): void {
  db.prepare("INSERT INTO notes (id, scope, target_id, text, origin, created_at) VALUES (?, ?, ?, ?, 'manual', '2026-09-21T00:00:00.000Z')").run(
    id,
    scope,
    targetId,
    text
  );
}

/**
 * RAG: RAG 系统 → 重排 → { 交叉编码器, 双塔编码器 } (part_of); 交叉编码器 contrasts 双塔编码器.
 * Agent: Agent Loop (no sources, stale, unknown kind). Uncategorized: 杂项 (only a deleted source item).
 */
export function seedKb(): AppDatabase {
  const appDb = openDatabase({ memory: true, skipVector: true });
  const db = appDb.db;
  db.prepare("INSERT INTO kb_categories (id, name, description, sort) VALUES ('cat-rag', 'RAG', '检索增强', 1), ('cat-agent', 'Agent', NULL, 2)").run();

  insertItem(db, "item-a", "webpage", "RAG 入门", 1200);
  insertItem(db, "item-b", "webpage", "重排模型对比", 600);
  insertItem(db, "item-q", "conversation", "ChatGPT · 交叉编码器和双塔有什么区别？", 120);
  insertItem(db, "item-del", "webpage", "已删除的页面", 300, true);

  insertEntry(db, { id: "kb-rag", name: "RAG 系统", category: "cat-rag", aliases: ["检索增强生成"] });
  insertEntry(db, {
    id: "kb-rerank",
    name: "重排",
    category: "cat-rag",
    kind: "method",
    aliases: ["Rerank"],
    completeness: { covered: ["定义"], missing: ["评估"] },
    patchCount: 9
  });
  insertEntry(db, {
    id: "kb-cross",
    name: "交叉编码器",
    category: "cat-rag",
    kind: "model",
    aliases: ["Cross-Encoder"],
    mastery: 0.8,
    masterySource: "user",
    userEdited: true
  });
  insertEntry(db, { id: "kb-bi", name: "双塔编码器", category: "cat-rag", kind: "model", mastery: 0.2 });
  insertEntry(db, { id: "kb-agent", name: "Agent Loop", category: "cat-agent", kind: "pattern", stale: true, mastery: 0.5 });
  insertEntry(db, { id: "kb-misc", name: "杂项", category: null, kind: "paper" });
  insertEntry(db, { id: "kb-gone", name: "已删除词条", category: "cat-rag", deleted: true });

  insertSource(db, "kb-rag", "item-a", [{ quote: "RAG 把检索结果拼进提示词" }], "blog", "2026-09-20T01:00:00.000Z");
  insertSource(db, "kb-rerank", "item-a", [{ quote: "召回后重排" }], "blog", "2026-09-20T01:00:00.000Z");
  insertSource(db, "kb-rerank", "item-b", [{ quote: "交叉编码器精度更高" }], "official_doc", "2026-09-22T01:00:00.000Z");
  insertSource(
    db,
    "kb-cross",
    "item-q",
    [{ quote: "交叉编码器同时编码 query 和文档", question: "交叉编码器和双塔有什么区别？", turn_item_id: "item-q" }],
    "ai_answer",
    "2026-09-23T01:00:00.000Z"
  );
  insertSource(db, "kb-bi", "item-q", [{ quote: "双塔分别编码", question: "交叉编码器和双塔有什么区别？" }], "ai_answer", "2026-09-23T01:00:00.000Z");
  insertSource(db, "kb-misc", "item-del", [{ quote: "x" }], "weird_kind", "2026-09-24T01:00:00.000Z");

  insertEdge(db, "kb-rerank", "kb-rag", "part_of", "item-a");
  insertEdge(db, "kb-cross", "kb-rerank", "part_of", "item-b");
  insertEdge(db, "kb-bi", "kb-rerank", "part_of");
  insertEdge(db, "kb-cross", "kb-bi", "contrasts", "item-q", "交叉编码器联合编码，精度高但慢；双塔可预计算，快。");
  insertEdge(db, "kb-rerank", "kb-agent", "related");
  insertEdge(db, "kb-gone", "kb-rag", "part_of");

  insertNote(db, "note-entry", "entry", "kb-rerank", "重排要关注延迟");
  insertNote(db, "note-item", "item", "item-a", "这篇讲得清楚");
  return appDb;
}
