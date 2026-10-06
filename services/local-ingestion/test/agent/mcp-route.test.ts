import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_SKILL_VERSION } from "../../src/domains/agent/tools.js";
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
  insertEntry(env.db, { id: "kb_rerank", name: "重排", aliases: ["Rerank"], kind: "方法", category: "检索", body: "## 定义\n\n重排是……\n\n## 公式\n<!-- section:s_formula1 src:item_old -->\n分数加权。" });

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
  assert.deepEqual(
    names,
    [
      "add_relation",
      "add_to_inbox",
      "attach_source",
      "finish_session",
      "finish_unit",
      "get_entry",
      "get_guidelines",
      "get_unit",
      "list_inbox",
      "list_vocab",
      "search_kb",
      "start_session",
      "write_entry"
    ]
  );
  assert.ok(body.result.tools.every((tool) => tool.inputSchema.type === "object"));
  const write = body.result.tools.find((tool) => tool.name === "write_entry") as unknown as { inputSchema: { properties: Record<string, unknown> } };
  assert.ok(["run_id", "unit_key", "entry_id", "new", "sections"].every((key) => key in write.inputSchema.properties));
});

test("read tools", async (t) => {
  const { call } = setup(t);

  const guidelines = await call("get_guidelines");
  assert.equal(guidelines.ok, true);
  assert.match(guidelines.version, /^organize-agent@3/);
  assert.match(guidelines.markdown, /## 写作规范/);

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
  assert.equal(doc.text, "# 重排\n\n重排模型对召回结果二次打分。");
  assert.equal(doc.turns, null);
  assert.equal("chunks" in doc, false);
  const thread = await call("get_unit", { unit_key: "turn_1" });
  assert.equal(thread.text, null);
  assert.deepEqual(thread.turns, [
    { turn_item_id: "turn_1", turn_index: 1, question: "什么是向量检索", answer: "向量检索按嵌入相似度召回。" },
    { turn_item_id: "turn_2", turn_index: 2, question: "和 BM25 的区别", answer: "BM25 基于词频。" }
  ]);
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
  assert.equal(entry.body, "## 定义\n重排是……\n\n## 公式\n分数加权。");
  assert.deepEqual(entry.sections, [{ section_id: "s_formula1", heading: "公式", source_item_ids: ["item_old"] }]);
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
  assert.equal(started.skill_version, AGENT_SKILL_VERSION);

  const busy = await call("start_session", {});
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "busy");
  assert.equal(busy.details.active_run_id, started.run_id);

  const exists = await call("write_entry", {
    run_id: started.run_id,
    unit_key: "item_doc",
    new: { name: "rerank", kind: "方法", summary: "s" },
    sections: [{ heading: "定义", markdown: "重排模型对召回结果二次打分。", source_item_ids: ["item_doc"] }]
  });
  assert.equal(exists.error, "name_exists");
  assert.equal(exists.details.entry_id, "kb_rerank");
  const written = await call("write_entry", {
    run_id: started.run_id,
    unit_key: "item_doc",
    entry_id: "kb_rerank",
    sections: [{ heading: "打分", markdown: "重排模型对召回结果二次打分。", source_item_ids: ["item_doc"] }]
  });
  assert.equal(written.ok, true);
  assert.equal((await call("finish_unit", { run_id: started.run_id, unit_key: "item_doc", status: "organized", reason: "补充" })).decision, "supplement");
  assert.deepEqual(
    (await call("get_entry", { entry_id: "kb_rerank" })).sections.map((section: { heading: string }) => section.heading),
    ["公式", "打分"]
  );
  const rejected = await call("finish_unit", { run_id: started.run_id, unit_key: "turn_1", status: "not_learning", reason: "闲聊" });
  assert.equal(rejected.ok, true);
  assert.equal(env.db.prepare("SELECT organize_status FROM items WHERE id = 'turn_1'").get()?.organize_status, "rejected");

  const finished = await call("finish_session", { run_id: started.run_id, summary: "done" });
  assert.equal(finished.ok, true);
  assert.ok(finished.stats);
  assert.equal((await call("finish_session", { run_id: started.run_id })).error, "run_not_active");
});
