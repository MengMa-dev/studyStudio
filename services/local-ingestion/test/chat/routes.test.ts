import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatCitationsDataSchema, chatMessagesResponseSchema, type ChatContext } from "@study-studio/shared";
import { createIngestionServer } from "../../src/create-server.js";
import { resetToolsSupportCache } from "../../src/domains/chat/fallback.js";

const token = "chat-token";

async function start(options: { configureModel?: boolean; toolsUnsupported?: boolean; limit?: number } = {}) {
  resetToolsSupportCache();
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-chat-"));
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken: token,
    disableScheduler: true,
    disableBackgroundIndex: true,
    skipVector: true,
    memory: true,
    ai: { retry: { retries: 0, baseDelayMs: 1, sleep: async () => {} }, mock: { chatToolsUnsupported: options.toolsUnsupported } }
  });
  if (options.configureModel !== false) {
    ingestion.aiConfig.insertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: "deterministic" });
    ingestion.aiConfig.setTaskModel({ task: "chat", providerId: "mock", model: "deterministic", fallbackProviderId: null, fallbackModel: null });
  }
  if (options.limit !== undefined) ingestion.aiConfig.setDailyTokenLimit(options.limit);
  const port = await ingestion.listen(0);
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  return {
    ingestion,
    call,
    async close() {
      await ingestion.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

type Chunk = { type: string; [key: string]: unknown };

function parseSse(text: string): Chunk[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

let seq = 0;
function chatBody(text: string, context: ChatContext = { page: "home" }, extra: Record<string, unknown> = {}) {
  seq += 1;
  return JSON.stringify({ message: { id: `user-${seq}`, role: "user", parts: [{ type: "text", text }] }, context, ...extra });
}

async function waitForMessages(call: Awaited<ReturnType<typeof start>>["call"], count: number) {
  for (let i = 0; i < 50; i++) {
    const body = chatMessagesResponseSchema.parse(JSON.parse((await call("/v1/chat/messages")).text));
    if (body.messages.length >= count) return body.messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return chatMessagesResponseSchema.parse(JSON.parse((await call("/v1/chat/messages")).text)).messages;
}

function streamText(chunks: Chunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta as string)
    .join("");
}

function citationsOf(chunks: Chunk[]) {
  const part = chunks.find((chunk) => chunk.type === "data-citations");
  assert.ok(part, "stream has data-citations");
  return chatCitationsDataSchema.parse(part.data);
}

test("POST /v1/chat streams tool calls, cited text and data-citations; GET replays; DELETE clears", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call } = server;

  const response = await call("/v1/chat", { method: "POST", body: chatBody("RAG 到底是什么") });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const chunks = parseSse(response.text);
  assert.equal(chunks[0]!.type, "start");
  assert.equal(typeof chunks[0]!.messageId, "string");
  assert.equal(chunks.at(-1)!.type, "finish");
  assert.equal(chunks.at(-2)!.type, "data-citations");
  assert.ok(chunks.some((chunk) => chunk.type === "tool-input-available" && chunk.toolName === "search_knowledge"));
  assert.match(streamText(chunks), /\[1\]/);
  const data = citationsOf(chunks);
  assert.equal(data.nonRecord, false);
  assert.equal(data.citations[0]!.n, 1);
  assert.equal(data.citations[0]!.kind, "entry");

  const messages = await waitForMessages(call, 2);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"]
  );
  const assistantParts = messages[1]!.parts as Chunk[];
  assert.ok(assistantParts.some((part) => part.type === "data-citations"));
  assert.ok(assistantParts.some((part) => part.type === "tool-search_knowledge"));
  const model = server.ingestion.db.db.prepare("SELECT model FROM chat_messages WHERE role = 'assistant'").get() as { model: string };
  assert.equal(model.model, "mock/deterministic");

  const second = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("我今天学了什么") })).text);
  assert.ok(second.some((chunk) => chunk.type === "tool-input-available" && chunk.toolName === "query_timeline"));
  assert.equal(citationsOf(second).citations[0]!.kind, "day");
  assert.equal((await waitForMessages(call, 4)).length, 4);

  const cleared = await call("/v1/chat/messages", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal(JSON.parse(cleared.text).deleted, 4);
  assert.deepEqual(JSON.parse((await call("/v1/chat/messages")).text), { messages: [] });
});

test("POST /v1/chat answers no-hit questions as non-record and replays cards", async (t) => {
  const server = await start();
  t.after(() => server.close());
  const { call } = server;

  const noHit = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("什么是 k8s") })).text);
  assert.match(streamText(noHit), /知识库没有相关内容/);
  assert.deepEqual(citationsOf(noHit), { citations: [], nonRecord: true });

  const organize = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("帮我整理该页知识点", { page: "item", itemId: "i1" }) })).text);
  assert.ok(organize.some((chunk) => chunk.type === "data-organize-card"));
  const profile = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("我最近在学 AI 相关知识") })).text);
  assert.ok(profile.some((chunk) => chunk.type === "data-profile-card"));

  const messages = await waitForMessages(call, 6);
  const replayed = messages.flatMap((message) => (message.parts as Chunk[]).map((part) => part.type));
  assert.ok(replayed.includes("data-organize-card"));
  assert.ok(replayed.includes("data-profile-card"));
  const context = server.ingestion.db.db.prepare("SELECT context FROM chat_messages WHERE role = 'user' AND context LIKE '%item%'").get() as {
    context: string;
  };
  assert.deepEqual(JSON.parse(context.context), { page: "item", itemId: "i1" });
});

test("POST /v1/chat returns 409 without a model, 429 over the limit and 400 on bad bodies", async (t) => {
  const unconfigured = await start({ configureModel: false });
  t.after(() => unconfigured.close());
  const missing = await unconfigured.call("/v1/chat", { method: "POST", body: chatBody("你好") });
  assert.equal(missing.status, 409);
  assert.deepEqual(JSON.parse(missing.text), { error: "chat_model_not_configured" });
  assert.deepEqual(JSON.parse((await unconfigured.call("/v1/chat/messages")).text), { messages: [] }, "user message not stored");

  const limited = await start({ limit: 1 });
  t.after(() => limited.close());
  limited.ingestion.db.db
    .prepare("INSERT INTO usage_daily (day, task, provider_id, calls, input_tokens, output_tokens) VALUES (?, 'chat', 'mock', 1, 5, 5)")
    .run(new Date().toISOString().slice(0, 10));
  const over = await limited.call("/v1/chat", { method: "POST", body: chatBody("你好") });
  assert.equal(over.status, 429);
  assert.deepEqual(JSON.parse(over.text), { error: "usage_limit_exceeded" });
  const allowed = await limited.call("/v1/chat", { method: "POST", body: chatBody("你好", { page: "home" }, { allowOverLimit: true }) });
  assert.equal(allowed.status, 200);

  const bad = await limited.call("/v1/chat", {
    method: "POST",
    body: JSON.stringify({ message: { id: "x", role: "assistant", parts: [] }, context: { page: "home" } })
  });
  assert.equal(bad.status, 400);
});

test("models without tools take the rule-based fallback path with the same answer types", async (t) => {
  const server = await start({ toolsUnsupported: true });
  t.after(() => server.close());
  const { call } = server;

  const timeline = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("我今天学了什么") })).text);
  assert.ok(!timeline.some((chunk) => chunk.type === "error"));
  assert.ok(!timeline.some((chunk) => chunk.type === "tool-input-available"), "no model tool calls");
  assert.match(streamText(timeline), /\[1\]/);
  assert.equal(citationsOf(timeline).citations[0]!.kind, "day");

  const knowledge = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("RAG 是什么") })).text);
  assert.equal(citationsOf(knowledge).citations[0]!.kind, "entry");

  const mastery = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("我哪些知识掌握得不好") })).text);
  assert.equal(citationsOf(mastery).citations[0]!.id, "stub-weak");

  const noHit = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("什么是 k8s") })).text);
  assert.equal(citationsOf(noHit).nonRecord, true);

  const organize = parseSse((await call("/v1/chat", { method: "POST", body: chatBody("整理") })).text);
  assert.ok(organize.some((chunk) => chunk.type === "data-organize-card"));
  assert.match(streamText(organize), /确认整理范围/);

  const messages = await waitForMessages(call, 10);
  const organizeRow = server.ingestion.db.db.prepare("SELECT model FROM chat_messages WHERE role = 'assistant' ORDER BY created_at DESC, rowid DESC").get() as {
    model: string | null;
  };
  assert.equal(organizeRow.model, null, "organize card produced without calling the model");
  assert.equal(messages.length, 10);
});
