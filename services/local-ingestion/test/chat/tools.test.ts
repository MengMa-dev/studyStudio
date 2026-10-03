import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { organizeRunRequestSchema, type ChatCitation, type ChatCitationKind, type ChatContext } from "@study-studio/shared";
import type { AiGateway } from "../../src/ai/gateway.js";
import { openDatabase } from "../../src/db/database.js";
import { readLearnerProfile, saveLearnerProfile } from "../../src/domains/data/profile.js";
import { CHAT_TOOL_NAMES, type ChatDataPartEmit, type ChatToolDeps, type ChatToolName, type CitationRegistry } from "../../src/domains/chat/contracts.js";
import { createChatTools } from "../../src/domains/chat/tools/index.js";
import { ENTRY_OWNER } from "../../src/domains/organize/runtime-types.js";
import { createSearchIndex } from "../../src/search/index-api.js";
import { addDays, localDay } from "../../src/domains/timeline/time.js";
import { seedKb } from "../kb/seed.js";

const NOW = new Date(2026, 9, 2, 15, 0, 0);
const TODAY = localDay(NOW);

class FakeRegistry implements CitationRegistry {
  readonly entries: ChatCitation[] = [];
  register(ref: { kind: ChatCitationKind; id: string; title: string }): number {
    const existing = this.entries.find((entry) => entry.kind === ref.kind && entry.id === ref.id);
    if (existing) return existing.n;
    const n = this.entries.length + 1;
    this.entries.push({ n, ...ref });
    return n;
  }
  resolve(text: string): ChatCitation[] {
    const ns = new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    return this.entries.filter((entry) => ns.has(entry.n));
  }
  size(): number {
    return this.entries.length;
  }
  get(kind: ChatCitationKind, id: string): ChatCitation | undefined {
    return this.entries.find((entry) => entry.kind === kind && entry.id === id);
  }
}

function setup(db: DatabaseSync, options: { context?: ChatContext; deps?: Partial<ChatToolDeps> } = {}) {
  const registry = new FakeRegistry();
  const emitted: ChatDataPartEmit[] = [];
  const tools = createChatTools(
    { db, now: () => NOW, ...options.deps },
    { context: options.context ?? { page: "home" }, registry, emit: (part) => emitted.push(part) }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (name: ChatToolName, input: unknown): Promise<any> => {
    const executable = tools[name] as unknown as { execute: (input: unknown, options: unknown) => unknown };
    return await executable.execute(input, { toolCallId: "call-1", messages: [], context: {} });
  };
  return { tools, registry, emitted, run };
}

/** Local wall-clock time `daysAgo` days before NOW, as ISO. */
function at(daysAgo: number, hour: number, minute = 0): string {
  return new Date(2026, 9, 2 - daysAgo, hour, minute).toISOString();
}

function insertItem(db: DatabaseSync, id: string, type: "webpage" | "conversation", title: string, capturedAt: string, site = "example.com"): void {
  db.prepare("INSERT INTO items (id, type, title, url, site, captured_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    type,
    title,
    `https://${site}/${id}`,
    site,
    capturedAt
  );
}

function insertEvent(db: DatabaseSync, id: string, type: string, itemId: string, occurredAt: string, payload: unknown = {}): void {
  db.prepare("INSERT INTO events (id, type, occurred_at, day, item_id, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    type,
    occurredAt,
    localDay(occurredAt),
    itemId,
    JSON.stringify(payload),
    occurredAt
  );
}

test("createChatTools exposes all seven tools", () => {
  const { db } = openDatabase({ memory: true, skipVector: true });
  const { tools } = setup(db);
  assert.deepEqual(Object.keys(tools).sort(), [...CHAT_TOOL_NAMES].sort());
  for (const name of CHAT_TOOL_NAMES) {
    const value = tools[name] as { description?: string; inputSchema?: unknown; execute?: unknown };
    assert.ok(value.description && value.inputSchema && typeof value.execute === "function", name);
  }
});

test("query_timeline: daily minutes, rows with refs, row cap and default 7-day range", async () => {
  const { db } = openDatabase({ memory: true, skipVector: true });
  insertItem(db, "page-1", "webpage", "交叉编码器", at(0, 9));
  insertEvent(db, "ev-1", "reading_session_closed", "page-1", at(0, 9, 10), { countedSeconds: 600, openedAt: at(0, 9) });
  insertItem(db, "qa-1", "conversation", "什么是重排？", at(1, 20, 2), "chatgpt.com");
  insertEvent(db, "ev-2", "user_message_sent", "qa-1", at(1, 20));
  for (let i = 0; i < 17; i += 1) insertItem(db, `bulk-${i}`, "webpage", `批量 ${i}`, at(3, 8, i));
  insertItem(db, "old", "webpage", "很久以前", at(30, 9));

  const { run, registry } = setup(db);
  const result = await run("query_timeline", {});
  assert.deepEqual([result.from, result.to], [addDays(TODAY, -6), TODAY]);
  assert.equal(result.note, undefined);
  assert.deepEqual(
    result.days.map((day: { day: string; minutes: number }) => [day.day, day.minutes]),
    [
      [TODAY, 10],
      [addDays(TODAY, -1), 2],
      [addDays(TODAY, -3), 0]
    ]
  );
  assert.equal(result.totalMinutes, 12);

  const [today, yesterday, bulk] = result.days;
  assert.equal(today.ref, registry.get("day", TODAY)!.n);
  assert.equal(registry.get("day", TODAY)!.title, `${TODAY} 学习记录`);
  assert.deepEqual(today.rows, [
    { ref: registry.get("item", "page-1")!.n, type: "webpage", title: "交叉编码器", site: "example.com", minutes: 10, itemId: "page-1" }
  ]);
  assert.deepEqual([yesterday.rows[0].title, yesterday.rows[0].minutes, yesterday.rows[0].itemId], ["ChatGPT · 什么是重排？", 2, "qa-1"]);
  assert.equal(bulk.rows.length, 15);
  assert.equal(bulk.moreRows, 2);
  assert.equal(registry.get("item", "old"), undefined);

  const narrowed = await setup(db).run("query_timeline", { from: addDays(TODAY, -1), to: addDays(TODAY, -1) });
  assert.deepEqual(
    narrowed.days.map((day: { day: string }) => day.day),
    [addDays(TODAY, -1)]
  );
});

test("query_timeline: empty range returns no_records", async () => {
  const { db } = openDatabase({ memory: true, skipVector: true });
  const { run, registry } = setup(db);
  const result = await run("query_timeline", { from: "2025-01-01", to: "2025-01-07" });
  assert.deepEqual(result, { from: "2025-01-01", to: "2025-01-07", totalMinutes: 0, days: [], note: "no_records" });
  assert.equal(registry.size(), 0);
});

function seedSearch(dimensions = 3) {
  const appDb = seedKb();
  const index = createSearchIndex(appDb.db, { forceMemory: true, dimensions });
  return { db: appDb.db, index };
}

async function indexKnowledge(index: ReturnType<typeof createSearchIndex>) {
  await index.indexDocument({ ownerType: ENTRY_OWNER.name, ownerId: "kb-cross", text: "交叉编码器 Cross-Encoder" }, [1, 0, 0]);
  await index.indexDocument({ ownerType: ENTRY_OWNER.summary, ownerId: "kb-cross", text: "交叉编码器同时编码 query 和文档，精度高但慢" }, [1, 0, 0]);
  await index.indexDocument({ ownerType: ENTRY_OWNER.body, ownerId: "kb-rerank", text: "重排：召回之后用交叉编码器重新排序候选文档" }, [0, 1, 0]);
  await index.indexDocument({ ownerType: "item", ownerId: "item-b", text: "重排模型对比：交叉编码器与双塔编码器" }, [0, 0, 1]);
  await index.indexDocument({ ownerType: ENTRY_OWNER.body, ownerId: "kb-gone", text: "已删除词条也提到交叉编码器" }, [0, 1, 0]);
  await index.indexDocument({ ownerType: "item", ownerId: "item-del", text: "已删除页面提到交叉编码器" }, [0, 0, 1]);
  await index.indexDocument({ ownerType: "note", ownerId: "n1", text: "交叉编码器的备注" }, [0, 0, 1]);
}

test("search_knowledge: without aiGateway uses FTS, groups by owner, skips deleted and unknown owners", async () => {
  const { db, index } = seedSearch();
  await indexKnowledge(index);
  const { run, registry } = setup(db, { deps: { searchIndex: index } });
  const result = await run("search_knowledge", { query: "交叉编码器" });
  assert.equal(result.retrieval, "fts");
  assert.equal(result.note, undefined);
  const ids = result.results.map((hit: { kind: string; id: string }) => `${hit.kind}:${hit.id}`);
  assert.deepEqual([...ids].sort(), ["entry:kb-cross", "entry:kb-rerank", "item:item-b"]);

  const cross = result.results.find((hit: { id: string }) => hit.id === "kb-cross");
  assert.deepEqual(
    { ...cross, snippet: undefined },
    {
      ref: registry.get("entry", "kb-cross")!.n,
      kind: "entry",
      id: "kb-cross",
      name: "交叉编码器",
      summary: "交叉编码器 简介",
      category: "RAG",
      mastery: 0.8,
      snippet: undefined
    }
  );
  assert.match(cross.snippet, /精度高/, "summary chunk preferred over the bare name chunk");
  const item = result.results.find((hit: { id: string }) => hit.id === "item-b");
  assert.deepEqual([item.title, item.type, item.ref], ["重排模型对比", "webpage", registry.get("item", "item-b")!.n]);

  const one = await setup(db, { deps: { searchIndex: index } }).run("search_knowledge", { query: "交叉编码器", k: 1 });
  assert.equal(one.results.length, 1);
});

test("search_knowledge: no hit returns no_match; works without a search index", async () => {
  const { db, index } = seedSearch();
  await indexKnowledge(index);
  const { run, registry } = setup(db);
  assert.deepEqual(await run("search_knowledge", { query: "量子力学" }), { results: [], retrieval: "fts", note: "no_match" });
  assert.equal(registry.size(), 0);
  const fts = await run("search_knowledge", { query: "交叉编码器" });
  assert.ok(fts.results.length > 0);
});

test("search_knowledge: hybrid with embeddings; falls back to FTS when embedding fails", async () => {
  const { db, index } = seedSearch();
  await indexKnowledge(index);
  const queries: string[] = [];
  const gateway = {
    embed: async ({ value }: { value: string }) => {
      queries.push(value);
      return { embedding: [1, 0, 0] };
    }
  } as unknown as AiGateway;
  const hybrid = await setup(db, { deps: { searchIndex: index, aiGateway: gateway } }).run("search_knowledge", { query: "完全无关的说法" });
  assert.equal(hybrid.retrieval, "hybrid");
  assert.deepEqual(queries, ["完全无关的说法"]);
  assert.equal(hybrid.results[0].id, "kb-cross", "vector recall finds entries without keyword overlap");

  const failing = { embed: async () => Promise.reject(new Error("embedding model not configured")) } as unknown as AiGateway;
  const fallback = await setup(db, { deps: { searchIndex: index, aiGateway: failing } }).run("search_knowledge", { query: "交叉编码器" });
  assert.equal(fallback.retrieval, "fts");
  assert.ok(fallback.results.some((hit: { id: string }) => hit.id === "kb-cross"));
});

test("get_entry: body, mastery, relations and sources are registered; long body truncated; missing → not_found", async () => {
  const { db } = seedKb();
  const { run, registry } = setup(db);
  const entry = await run("get_entry", { id: "kb-rerank" });
  assert.equal(entry.ref, registry.get("entry", "kb-rerank")!.n);
  assert.deepEqual([entry.name, entry.category, entry.bodyTruncated], ["重排", "RAG", false]);
  assert.match(entry.body, /重排 的正文/);
  assert.deepEqual(entry.completeness, { covered: ["定义"], missing: ["评估"] });
  assert.equal(typeof entry.mastery, "number");
  assert.deepEqual(entry.relations.map((relation: { id: string }) => relation.id).sort(), ["kb-agent", "kb-bi", "kb-cross", "kb-rag"]);
  for (const relation of entry.relations) assert.equal(relation.ref, registry.get("entry", relation.id)!.n);
  assert.deepEqual(entry.sources.map((source: { itemId: string; title: string }) => [source.itemId, source.title]).sort(), [
    ["item-a", "RAG 入门"],
    ["item-b", "重排模型对比"]
  ]);
  for (const source of entry.sources) assert.equal(source.ref, registry.get("item", source.itemId)!.n);

  db.prepare("UPDATE kb_entries SET body_markdown = ? WHERE id = 'kb-rag'").run("长".repeat(7000));
  const long = await run("get_entry", { id: "kb-rag" });
  assert.equal(long.bodyTruncated, true);
  assert.equal(long.body.length, 6001);

  const before = registry.size();
  assert.deepEqual(await run("get_entry", { id: "kb-gone" }), { error: "not_found", id: "kb-gone" });
  assert.equal(registry.size(), before);
});

test("get_item: webpage content, conversation question + answer, related entries; missing → not_found", async () => {
  const { db } = seedKb();
  db.prepare("INSERT INTO item_contents (item_id, markdown) VALUES ('item-a', ?)").run(`# RAG 入门\n\n${"内容".repeat(4000)}`);
  db.prepare("INSERT INTO item_contents (item_id, markdown, question) VALUES ('item-q', '交叉编码器联合编码。', '交叉编码器和双塔有什么区别？')").run();
  const { run, registry } = setup(db);

  const page = await run("get_item", { id: "item-a" });
  assert.equal(page.ref, registry.get("item", "item-a")!.n);
  assert.deepEqual(
    [page.title, page.type, page.url, page.readingMinutes, page.contentTruncated],
    ["RAG 入门", "webpage", "https://example.com/item-a", 20, true]
  );
  assert.equal(page.content.length, 6001);
  assert.equal(page.question, undefined);
  assert.deepEqual(page.relatedEntries.map((entry: { id: string }) => entry.id).sort(), ["kb-rag", "kb-rerank"]);
  for (const entry of page.relatedEntries) assert.equal(entry.ref, registry.get("entry", entry.id)!.n);

  const qa = await run("get_item", { id: "item-q" });
  assert.deepEqual([qa.type, qa.question, qa.content, qa.contentTruncated], ["conversation", "交叉编码器和双塔有什么区别？", "交叉编码器联合编码。", false]);

  assert.deepEqual(await run("get_item", { id: "item-del" }), { error: "not_found", id: "item-del" });
  assert.deepEqual(await run("get_item", { id: "nope" }), { error: "not_found", id: "nope" });
});

test("list_mastery: weak below WEAK_MASTERY_THRESHOLD weakest first, familiar strongest first; empty → no_entries", async () => {
  const { db } = seedKb();
  const { run, registry } = setup(db);
  const weak = await run("list_mastery", { level: "weak" });
  assert.equal(weak.threshold, 0.4);
  assert.deepEqual(
    weak.entries.map((entry: { id: string }) => entry.id),
    ["kb-bi", "kb-rag"]
  );
  assert.ok(weak.entries[0].mastery <= weak.entries[1].mastery && weak.entries[1].mastery < 0.4);
  assert.equal(weak.entries[0].category, "RAG");
  assert.equal(weak.entries[0].ref, registry.get("entry", "kb-bi")!.n);

  const familiar = await run("list_mastery", { level: "familiar" });
  assert.deepEqual(
    familiar.entries.map((entry: { id: string; mastery: number }) => [entry.id, entry.mastery]),
    [["kb-cross", 0.8]]
  );

  const limited = await run("list_mastery", { level: "weak", limit: 1 });
  assert.deepEqual([limited.entries.length, limited.total], [1, 2]);

  const empty = openDatabase({ memory: true, skipVector: true });
  assert.deepEqual(await setup(empty.db).run("list_mastery", { level: "familiar" }), {
    level: "familiar",
    threshold: 0.65,
    total: 0,
    entries: [],
    note: "no_entries"
  });
});

test("propose_organize: emits a valid organize card and never runs organize", async () => {
  const { db } = seedKb();
  const runsBefore = db.prepare("SELECT COUNT(*) AS n FROM organize_runs").get() as { n: number };
  const { run, emitted, registry } = setup(db, { context: { page: "entry", entryId: "kb-rerank" } });
  const result = await run("propose_organize", { target: "current", requirement: "补充评估方法" });
  assert.equal(result.status, "card_shown");
  assert.deepEqual(result.options, ["当前知识点：重排"]);
  assert.match(result.note, /不要声称已开始/);
  assert.deepEqual(emitted, [
    {
      type: "organize-card",
      data: {
        options: [{ scope: "entry", label: "当前知识点", itemIds: [], entryIds: ["kb-rerank"], targetName: "重排" }],
        requirement: "补充评估方法"
      }
    }
  ]);
  assert.equal(registry.size(), 0);

  const ask = setup(db, { context: { page: "inbox", selectedItemIds: ["item-a"] } });
  const asked = await ask.run("propose_organize", { target: "ask" });
  assert.deepEqual(asked.options, ["待整理", "全量", "已选（1 条）"]);
  const card = ask.emitted[0]!;
  assert.equal(card.type, "organize-card");
  if (card.type === "organize-card") {
    assert.equal("requirement" in card.data, false);
    for (const option of card.data.options) organizeRunRequestSchema.parse(option);
  }
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM organize_runs").get(), runsBefore);
});

test("record_learner_profile: role overrides, direction appends with TTL and dedupe, card carries previous", async () => {
  const { db } = openDatabase({ memory: true, skipVector: true });
  const { run, emitted } = setup(db);

  assert.deepEqual(await run("record_learner_profile", { role: "产品经理" }), { status: "saved", role: "产品经理", directions: [] });
  assert.deepEqual(emitted[0], { type: "profile-card", data: { role: "产品经理", previous: { role: "", directions: [] } } });

  assert.deepEqual(await run("record_learner_profile", { direction: "AI 相关知识" }), { status: "saved", role: "产品经理", directions: ["AI 相关知识"] });
  assert.deepEqual(emitted[1], { type: "profile-card", data: { direction: "AI 相关知识", previous: { role: "产品经理", directions: [] } } });
  const saved = readLearnerProfile(db);
  assert.equal(saved.directions.length, 1);
  assert.equal(saved.directions[0]!.expiresAt, addDays(TODAY, 30));
  assert.ok(saved.directions[0]!.id);

  await run("record_learner_profile", { role: "工程师", direction: "ai 相关知识" });
  const renewed = readLearnerProfile(db);
  assert.equal(renewed.role, "工程师");
  assert.deepEqual(
    renewed.directions.map((direction) => [direction.id, direction.text]),
    [[saved.directions[0]!.id, "AI 相关知识"]],
    "same direction is renewed, not duplicated"
  );
  assert.deepEqual(emitted[2], {
    type: "profile-card",
    data: { role: "工程师", direction: "ai 相关知识", previous: { role: "产品经理", directions: saved.directions } }
  });

  assert.deepEqual(await run("record_learner_profile", {}), { status: "ignored", reason: "empty_input" });
  assert.equal(emitted.length, 3);
});

test("record_learner_profile: drops expired directions and keeps the newest 20", async () => {
  const { db } = openDatabase({ memory: true, skipVector: true });
  const valid = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `d${i}`, text: `方向 ${i}`, expiresAt: addDays(TODAY, 10) }));
  saveLearnerProfile(db, { role: "", directions: [{ id: "expired", text: "旧方向", expiresAt: addDays(TODAY, -1) }, ...valid(19)] });
  const { run, emitted } = setup(db);
  await run("record_learner_profile", { direction: "新方向" });
  const pruned = readLearnerProfile(db);
  assert.equal(pruned.directions.length, 20);
  assert.equal(pruned.directions[0]!.id, "d0", "expired direction dropped");
  assert.equal(pruned.directions.at(-1)!.text, "新方向");
  const card = emitted[0]!;
  assert.equal(card.type === "profile-card" && card.data.previous.directions[0]!.id, "expired");

  saveLearnerProfile(db, { role: "", directions: valid(20) });
  await run("record_learner_profile", { direction: "又一个方向" });
  const capped = readLearnerProfile(db);
  assert.equal(capped.directions.length, 20);
  assert.equal(capped.directions[0]!.id, "d1", "oldest direction dropped at the limit");
  assert.equal(capped.directions.at(-1)!.text, "又一个方向");
});
