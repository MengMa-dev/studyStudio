import { test } from "node:test";
import assert from "node:assert/strict";
import { PresenceStore } from "../../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../../src/http/app.js";
import { createEnv, createReplayGateway, insertEntry, insertItem, insertNote, insertSelection } from "../organize/helpers.js";

const port = 43119;
const MCP_TOKEN = "mcp-tok";

function setup(t: { after: (fn: () => void) => void }) {
  const env = createEnv();
  t.after(() => env.app.close());
  insertItem(env.db, { id: "item_doc", title: "RAG 重排", capturedAt: "2026-10-02T10:00:00.000Z", markdown: "# 重排\n\n重排模型对召回结果二次打分。" });
  insertItem(env.db, {
    id: "turn_1",
    type: "conversation",
    title: "什么是向量检索",
    capturedAt: "2026-10-02T11:00:00.000Z",
    markdown: "向量检索按嵌入相似度召回。",
    question: "什么是向量检索",
    conversationId: "conv_1"
  });
  insertItem(env.db, {
    id: "turn_2",
    type: "conversation",
    title: "和 BM25 的区别",
    capturedAt: "2026-10-02T11:05:00.000Z",
    markdown: "BM25 基于词频。",
    question: "和 BM25 的区别",
    conversationId: "conv_1"
  });
  insertItem(env.db, { id: "item_done", title: "已整理", capturedAt: "2026-10-02T09:00:00.000Z", markdown: "done", status: "ingested" });
  insertNote(env.db, { id: "note_1", scope: "item", targetId: "item_doc", text: "重排很关键", createdAt: "2026-10-02T10:01:00.000Z" });
  insertSelection(env.db, "item_doc", "二次打分", "2026-10-02T10:02:00.000Z");
  insertEntry(env.db, { id: "kb_rerank", name: "重排", aliases: ["Rerank"], kind: "方法", category: "检索", body: "## 定义\n\n重排是……" });

  const app = createApp({
    appDb: env.app,
    auth: createAuthState("tok", port, MCP_TOKEN),
    presence: new PresenceStore(),
    ingestCtx: { app: env.app },
    getPort: () => port,
    workbenchDist: "/nonexistent-workbench-dist",
    aiGateway: createReplayGateway([]).gateway,
    searchIndex: env.searchIndex
  });
  let nextId = 1;
  const rpc = async (method: string, params: unknown, token: string | null = MCP_TOKEN) =>
    app.request(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, any>;
  };
  return { env, rpc, call };
}

test("rejects missing / wrong token and pairing token", async (t) => {
  const { rpc } = setup(t);
  assert.equal((await rpc("tools/list", {}, null)).status, 401);
  assert.equal((await rpc("tools/list", {}, "tok")).status, 401);
});

test("tools/list exposes read and session tools", async (t) => {
  const { rpc } = setup(t);
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } };
  const names = body.result.tools.map((tool) => tool.name).sort();
  for (const name of ["get_guidelines", "list_inbox", "get_unit", "search_kb", "get_entry", "list_vocab", "start_session", "finish_session", "submit_decision"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(body.result.tools.every((tool) => tool.inputSchema.type === "object"));
  const submit = body.result.tools.find((tool) => tool.name === "submit_decision") as unknown as { inputSchema: { properties: Record<string, unknown> } };
  assert.ok(["decision", "points", "compose", "target_entry_ids", "reject_reason"].every((key) => key in submit.inputSchema.properties));
});

test("read tools", async (t) => {
  const { call } = setup(t);

  const guidelines = await call("get_guidelines", { stage: "triage" });
  assert.equal(guidelines.ok, true);
  assert.match(guidelines.version, /^organize-agent@1/);
  assert.match(guidelines.markdown, /## 判定/);

  const inbox = await call("list_inbox", { limit: 1 });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.units.length, 1);
  assert.equal(inbox.units[0].unit_key, "item_doc");
  assert.equal(inbox.units[0].has_note, true);
  assert.equal(inbox.units[0].has_highlight, true);
  assert.equal(inbox.next_cursor, "1");
  const page2 = await call("list_inbox", { cursor: inbox.next_cursor });
  assert.deepEqual(page2.units.map((unit: { unit_key: string }) => unit.unit_key), ["turn_1"]);
  assert.deepEqual(page2.units[0].item_ids, ["turn_1", "turn_2"]);
  assert.equal(page2.next_cursor, null);

  const doc = await call("get_unit", { unit_key: "item_doc" });
  assert.equal(doc.ok, true);
  assert.equal(doc.user_note, "重排很关键");
  assert.deepEqual(doc.user_highlights, ["二次打分"]);
  assert.match(doc.chunks[0].text, /重排模型对召回结果二次打分/);
  const thread = await call("get_unit", { unit_key: "turn_1" });
  assert.deepEqual(
    thread.chunks[0].turns.map((turn: { question: string }) => turn.question),
    ["什么是向量检索", "和 BM25 的区别"]
  );
  assert.deepEqual(await call("get_unit", { unit_key: "item_done" }), {
    ok: false,
    error: "unit_not_found",
    message: "单元不存在或已整理，请重新调用 list_inbox"
  });

  const search = await call("search_kb", { query: "rerank" });
  assert.equal(search.ok, true);
  assert.equal(search.entries[0].entry_id, "kb_rerank");
  assert.equal(search.entries[0].category, "检索");
  assert.equal((await call("search_kb", { query: "重排模型" })).entries[0]?.entry_id, "kb_rerank");

  const entry = await call("get_entry", { entry_id: "kb_rerank" });
  assert.equal(entry.ok, true);
  assert.equal(entry.name, "重排");
  assert.deepEqual(entry.outline, ["## 定义"]);
  assert.equal((await call("get_entry", { entry_id: "missing" })).error, "entry_not_found");

  const vocab = await call("list_vocab");
  assert.equal(vocab.ok, true);
  assert.ok(vocab.kinds.includes("方法"));
  assert.deepEqual(vocab.categories, ["检索"]);
  assert.deepEqual(vocab.ignored_names, []);
});

test("session tools", async (t) => {
  const { call, env } = setup(t);
  const started = await call("start_session", { client: "test" });
  assert.equal(started.ok, true);
  assert.equal(typeof started.run_id, "string");
  assert.equal(started.skill_version, 1);

  const busy = await call("start_session", {});
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "busy");
  assert.equal(busy.details.active_run_id, started.run_id);

  const invalid = await call("submit_decision", { run_id: started.run_id, unit_key: "item_doc", decision: "reject", reason: "x" });
  assert.equal(invalid.error, "invalid_input");
  const rejected = await call("submit_decision", { run_id: started.run_id, unit_key: "turn_1", decision: "not_learning", reason: "闲聊" });
  assert.equal(rejected.ok, true);
  assert.equal(env.db.prepare("SELECT organize_status FROM items WHERE id = 'turn_1'").get()?.organize_status, "rejected");

  const finished = await call("finish_session", { run_id: started.run_id, summary: "done" });
  assert.equal(finished.ok, true);
  assert.ok(finished.stats);
  assert.equal((await call("finish_session", { run_id: started.run_id })).error, "run_not_active");
});
