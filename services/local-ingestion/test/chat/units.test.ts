import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { openDatabase } from "../../src/db/database.js";
import { saveLearnerProfile } from "../../src/domains/data/profile.js";
import { createCitationRegistry } from "../../src/domains/chat/citations.js";
import { detectFallbackCalls, detectTimeRange, isOrganizeCommand, isProfileStatement } from "../../src/domains/chat/fallback.js";
import { buildChatSystemPrompt } from "../../src/domains/chat/prompt.js";
import { historyForModel, trimHistory } from "../../src/domains/chat/service.js";
import { appendMessage, clearMessages, listMessages, truncateAfter } from "../../src/domains/chat/store.js";

test("citation registry dedupes objects and keeps only registered [n] in order", () => {
  const registry = createCitationRegistry();
  assert.equal(registry.register({ kind: "entry", id: "e1", title: "RAG" }), 1);
  assert.equal(registry.register({ kind: "day", id: "2026-10-03", title: "今天" }), 2);
  assert.equal(registry.register({ kind: "entry", id: "e1", title: "RAG" }), 1);
  assert.equal(registry.size(), 2);
  assert.deepEqual(
    registry.resolve("见 [2]，另见 [1][9] 与 [2]").map((citation) => citation.n),
    [1, 2]
  );
  assert.deepEqual(registry.resolve("没有引用"), []);
  assert.deepEqual(
    registry.resolve("全角【2】与列表 [1, 2]、【1、2】、【1†ref1】；链接 [1](http://x) 不算").map((citation) => citation.n),
    [1, 2]
  );
  assert.deepEqual(
    registry.resolve("链接 [1](http://x) 不算").map((citation) => citation.n),
    []
  );
});

test("short organize commands skip the model; questions about organizing do not", () => {
  for (const text of ["整理", "帮我整理该页知识点", "整理全部未整理内容"]) assert.equal(isOrganizeCommand(text), true, text);
  for (const text of ["我今天整理了什么", "整理是什么意思？", "怎么整理知识库", "RAG 是什么"]) assert.equal(isOrganizeCommand(text), false, text);
});

test("profile statements are saved directly; questions about oneself are not", () => {
  for (const text of ["我是前端开发", "我最近在学 Agent 架构", "最近在学 Rust"]) assert.equal(isProfileStatement(text), true, text);
  for (const text of ["我是谁", "我是不是学过 RAG？", "我最近学了什么", "RAG 是什么"]) assert.equal(isProfileStatement(text), false, text);
  assert.deepEqual(detectFallbackCalls("我掌握得比较好的知识有哪些", { page: "home" }, "2026-10-03"), [{ tool: "list_mastery", input: { level: "familiar" } }]);
  assert.deepEqual(detectFallbackCalls("哪些掌握得不太好", { page: "home" }, "2026-10-03"), [{ tool: "list_mastery", input: { level: "weak" } }]);
  assert.deepEqual(detectFallbackCalls("最近在学 Rust", { page: "home" }, "2026-10-03"), [{ tool: "record_learner_profile", input: { direction: "Rust" } }]);
});

test("fallback intent rules map phrases to tools", () => {
  const today = "2026-10-03"; // Saturday
  const home = { page: "home" as const };
  assert.deepEqual(detectTimeRange("我今天学了什么", today), { from: today, to: today });
  assert.deepEqual(detectTimeRange("昨天", today), { from: "2026-10-02", to: "2026-10-02" });
  assert.deepEqual(detectTimeRange("本周学了哪些", today), { from: "2026-09-28", to: today });
  assert.deepEqual(detectTimeRange("最近 3 天", today), { from: "2026-10-01", to: today });
  assert.deepEqual(detectTimeRange("最近一周学了哪些", today), { from: "2026-09-27", to: today });
  assert.deepEqual(detectTimeRange("9月30日看了什么", today), { from: "2026-09-30", to: "2026-09-30" });
  assert.equal(detectTimeRange("RAG 是什么", today), null);

  assert.deepEqual(detectFallbackCalls("帮我整理该页知识点", home, today), [{ tool: "propose_organize", input: { target: "current" } }]);
  assert.deepEqual(detectFallbackCalls("整理", home, today), [{ tool: "propose_organize", input: { target: "ask" } }]);
  assert.deepEqual(detectFallbackCalls("我最近在学 AI 相关知识", home, today), [{ tool: "record_learner_profile", input: { direction: "AI" } }]);
  assert.deepEqual(detectFallbackCalls("我是产品经理", home, today), [{ tool: "record_learner_profile", input: { role: "产品经理" } }]);
  assert.deepEqual(detectFallbackCalls("我哪些知识掌握得不好", home, today), [{ tool: "list_mastery", input: { level: "weak" } }]);
  assert.deepEqual(detectFallbackCalls("这个知识点讲解是否完整", { page: "entry", entryId: "e1" }, today), [
    { tool: "search_knowledge", input: { query: "这个知识点讲解是否完整", k: 6 } },
    { tool: "get_entry", input: { id: "e1" } }
  ]);
});

test("chat store keeps session order, upserts by id and clears", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-chat-store-"));
  const app = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const message = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  appendMessage(app.db, "main", { message: message("u1", "user", "a"), context: { page: "home" }, createdAt: "2026-10-03T00:00:00.000Z" });
  appendMessage(app.db, "main", { message: message("a1", "assistant", "b"), model: "mock/m", createdAt: "2026-10-03T00:00:01.000Z" });
  appendMessage(app.db, "main", { message: message("u2", "user", "c"), createdAt: "2026-10-03T00:00:02.000Z" });
  appendMessage(app.db, "other", { message: message("x", "user", "x") });
  appendMessage(app.db, "main", { message: message("u1", "user", "a2") });

  assert.deepEqual(
    listMessages(app.db, "main").map((m) => m.id),
    ["u1", "a1", "u2"]
  );
  assert.deepEqual(listMessages(app.db, "main")[0]!.parts, [{ type: "text", text: "a2" }]);
  assert.deepEqual(
    listMessages(app.db, "main", 2).map((m) => m.id),
    ["a1", "u2"]
  );
  assert.equal(truncateAfter(app.db, "main", "a1"), 1);
  assert.deepEqual(
    listMessages(app.db, "main").map((m) => m.id),
    ["u1", "a1"]
  );
  assert.equal(truncateAfter(app.db, "main", "missing"), 0);
  assert.equal(clearMessages(app.db, "main"), 2);
  assert.equal(listMessages(app.db, "main").length, 0);
  assert.equal(listMessages(app.db, "other").length, 1);
});

test("history trimming keeps the newest message within the char budget", () => {
  const msg = (id: string, size: number): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: "x".repeat(size) }] });
  assert.deepEqual(
    trimHistory([msg("a", 100), msg("b", 100), msg("c", 100)], 260).map((m) => m.id),
    ["b", "c"]
  );
  assert.deepEqual(
    trimHistory([msg("a", 100), msg("big", 1000)], 50).map((m) => m.id),
    ["big"]
  );
});

test("system prompt carries profile, date, time zone, page titles and rules", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-chat-prompt-"));
  const app = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  saveLearnerProfile(app.db, {
    role: "产品经理",
    directions: [
      { id: "d1", text: "AI Agent", expiresAt: "2026-10-30" },
      { id: "d2", text: "过期方向", expiresAt: "2026-01-01" }
    ]
  });
  const prompt = buildChatSystemPrompt(app.db, { page: "entry", entryId: "missing" }, new Date(2026, 9, 3, 12));
  assert.match(prompt, /产品经理/);
  assert.match(prompt, /AI Agent/);
  assert.doesNotMatch(prompt, /过期方向/);
  assert.match(prompt, /2026-10-03（周六）/);
  assert.match(prompt, /时区：/);
  assert.match(prompt, /词条详情/);
  assert.match(prompt, /missing/);
  assert.match(prompt, /以下内容非学习记录/);
  assert.match(prompt, /propose_organize/);
  assert.match(prompt, /record_learner_profile/);
});

test("earlier turns reach the model as plain text without citation markers", () => {
  const history = [
    { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "RAG 是什么" }] },
    {
      id: "a1",
      role: "assistant" as const,
      parts: [
        { type: "step-start" as const },
        { type: "tool-get_entry", toolCallId: "c1", state: "output-available", input: { id: "e1" }, output: { ref: 1 } },
        { type: "text" as const, text: "RAG 先检索再生成 [1]【2】。" },
        { type: "data-citations" as const, data: { citations: [], nonRecord: false } }
      ]
    },
    { id: "a2", role: "assistant" as const, parts: [{ type: "data-organize-card" as const, data: {} }] },
    { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "它和哪些知识点有关" }] }
  ] as unknown as UIMessage[];
  assert.deepEqual(
    historyForModel(history).map((message) => [message.id, message.parts]),
    [
      ["u1", [{ type: "text", text: "RAG 是什么" }]],
      ["a1", [{ type: "text", text: "RAG 先检索再生成 。" }]],
      ["u2", [{ type: "text", text: "它和哪些知识点有关" }]]
    ]
  );
});
