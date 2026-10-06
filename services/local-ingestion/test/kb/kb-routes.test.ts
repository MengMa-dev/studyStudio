import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KB_API,
  kbDeleteImpactResponseSchema,
  kbDeleteResponseSchema,
  kbEntryDetailSchema,
  kbKindRenameResponseSchema,
  kbKindsResponseSchema,
  kbTreeResponseSchema,
  NOTES_API,
  noteSchema,
  notesListResponseSchema,
  TRASH_API,
  trashListResponseSchema,
  trashRestoreResponseSchema,
  type KbDeleteRequestInput,
  type KbEntryPatch
} from "@study-studio/shared";
import { PresenceStore } from "../../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../../src/http/app.js";
import { seedKb } from "./seed.js";

const port = 43119;

function setup(t: { after: (fn: () => void) => void }) {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const app = createApp({
    appDb,
    auth: createAuthState("tok", port),
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: "/nonexistent-workbench-dist"
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { host: `127.0.0.1:${port}`, authorization: "Bearer tok", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
    });
  return { appDb, call };
}

test("GET tree / flat search parse with shared schema", async (t) => {
  const { call } = setup(t);
  const tree = await call("GET", KB_API.tree);
  assert.equal(tree.status, 200);
  const parsed = kbTreeResponseSchema.parse(await tree.json());
  assert.equal(parsed.mode, "tree");
  assert.equal(parsed.categories[0]!.children[0]!.children[0]!.name, "重排");

  const flat = kbTreeResponseSchema.parse(
    await (await call("GET", `${KB_API.tree}?q=${encodeURIComponent("重排")}&kind=${encodeURIComponent("方法")}`)).json()
  );
  assert.equal(flat.mode, "flat");
  assert.deepEqual(
    flat.entries.map((e) => e.id),
    ["kb-rerank"]
  );
  assert.equal((await call("GET", `${KB_API.tree}?kind=${"x".repeat(9)}`)).status, 422);
  assert.equal(kbTreeResponseSchema.parse(await (await call("GET", `${KB_API.tree}?q=`)).json()).mode, "tree");
});

function addKindEntries(db: ReturnType<typeof seedKb>["db"]) {
  const insert = db.prepare("INSERT INTO kb_entries(id, name, kind, user_edited, deleted_at) VALUES (?, ?, ?, 0, ?)");
  insert.run("kb-bleu", "BLEU", "评测指标", null);
  insert.run("kb-rouge", "ROUGE", "评测指标", null);
  insert.run("kb-imagenet", "ImageNet", "数据集", null);
  insert.run("kb-dead", "已删", "数据集", "2026-09-30T00:00:00.000Z");
  insert.run("kb-dead2", "已删2", "孤儿类型", "2026-09-30T00:00:00.000Z");
}

test("GET /kb/kinds: seeds first, then by count; deleted entries ignored", async (t) => {
  const { call, appDb } = setup(t);
  addKindEntries(appDb.db);
  const { kinds } = kbKindsResponseSchema.parse(await (await call("GET", KB_API.kinds)).json());
  assert.deepEqual(
    kinds.map((k) => [k.name, k.entryCount, k.seed]),
    [
      ["概念", 1, true],
      ["原理", 0, true],
      ["事实", 0, true],
      ["方法", 1, true],
      ["技巧", 1, true],
      ["规范", 0, true],
      ["工具/资源", 3, true],
      ["案例", 0, true],
      ["复盘", 0, true],
      ["其他", 0, true],
      ["评测指标", 2, false],
      ["数据集", 1, false]
    ]
  );
  const flat = kbTreeResponseSchema.parse(await (await call("GET", `${KB_API.tree}?kind=${encodeURIComponent("评测指标")}`)).json());
  assert.equal(flat.mode, "flat");
  assert.deepEqual(flat.entries.map((e) => e.id).sort(), ["kb-bleu", "kb-rouge"]);
});

test("PATCH /kb/kinds: rename, merge, no-op, validation", async (t) => {
  const { call, appDb } = setup(t);
  addKindEntries(appDb.db);
  const rename = async (body: unknown) => {
    const res = await call("PATCH", KB_API.kinds, body);
    return res.status === 200 ? kbKindRenameResponseSchema.parse(await res.json()).updated : res.status;
  };
  const kindOf = (id: string) => (appDb.db.prepare("SELECT kind FROM kb_entries WHERE id = ?").get(id) as { kind: string }).kind;

  assert.equal(await rename({ from: "评测指标", to: "事实" }), 2);
  assert.equal(kindOf("kb-bleu"), "事实");
  assert.equal(await rename({ from: "数据集", to: "工具/资源" }), 1);
  assert.equal(kindOf("kb-imagenet"), "工具/资源");
  assert.equal(kindOf("kb-dead"), "数据集", "deleted entries untouched");
  assert.equal(await rename({ from: "工具/资源", to: "工具/资源" }), 0);
  assert.equal(await rename({ from: "工具/资源", to: "案例" }), 4, "legacy codes count as their Chinese name");
  assert.equal(kindOf("kb-cross"), "案例");
  assert.equal(await rename({ from: "案例", to: "自定义" }), 422, "custom kinds are disabled");
  assert.equal(await rename({ from: "", to: "x" }), 422);
  assert.equal(await rename({ from: "a", to: "x".repeat(9) }), 422);
  assert.equal(await rename("{"), 400);
});

test("GET entry detail and 404", async (t) => {
  const { call } = setup(t);
  const res = await call("GET", KB_API.entry("kb-cross"));
  assert.equal(res.status, 200);
  const detail = kbEntryDetailSchema.parse(await res.json());
  assert.equal(detail.renderedSections.faqs.length, 1);
  assert.equal((await call("GET", KB_API.entry("missing"))).status, 404);
});

test("POST /v1/notes: entry note anchored to a section shows up in the detail; invalid anchors → 422", async (t) => {
  const { appDb, call } = setup(t);
  appDb.db
    .prepare("UPDATE kb_entries SET body_markdown = ? WHERE id = 'kb-rerank'")
    .run("## 定义\n<!-- section:s_def00001 src:item-a -->\n召回后重排。");
  const created = await call("POST", NOTES_API.create, { scope: "entry", targetId: "kb-rerank", text: "这节要补延迟数据", anchor: "s_def00001" });
  assert.equal(created.status, 201);
  const note = noteSchema.parse(await created.json());
  assert.equal(note.anchor, "s_def00001");

  const detail = kbEntryDetailSchema.parse(await (await call("GET", KB_API.entry("kb-rerank"))).json());
  assert.deepEqual(detail.sections, [{ id: "s_def00001", heading: "定义", sourceItemIds: ["item-a"] }]);
  assert.deepEqual(
    detail.notes.map((n) => [n.text, n.anchor]),
    [
      ["重排要关注延迟", null],
      ["这节要补延迟数据", "s_def00001"]
    ]
  );
  const listed = notesListResponseSchema.parse(await (await call("GET", `${NOTES_API.list}?scope=entry&targetId=kb-rerank`)).json());
  assert.equal(listed.notes.find((n) => n.id === note.id)?.anchor, "s_def00001");

  const bad = async (body: Record<string, unknown>) => (await call("POST", NOTES_API.create, { text: "x", ...body })).status;
  assert.equal(await bad({ scope: "entry", targetId: "kb-rerank", anchor: "s_missing0" }), 422);
  assert.equal(await bad({ scope: "item", targetId: "item-a", anchor: "s_def00001" }), 422);
});

test("PATCH entry: body, mastery, validation", async (t) => {
  const { call } = setup(t);
  const patch: KbEntryPatch = { bodyMarkdown: "## 定义\n\n改过\n", mastery: 0.6 };
  const res = await call("PATCH", KB_API.patch("kb-rag"), patch);
  assert.equal(res.status, 200);
  const detail = kbEntryDetailSchema.parse(await res.json());
  assert.equal(detail.userEdited, true);
  assert.equal(detail.dirty, true);
  assert.equal(detail.mastery, 0.6);
  assert.equal(detail.masterySource, "user");

  assert.equal((await call("PATCH", KB_API.patch("kb-rerank"), { kind: "评测指标" })).status, 422);
  const kindRes = await call("PATCH", KB_API.patch("kb-rerank"), { kind: "事实" });
  assert.equal(kindRes.status, 200);
  const kindDetail = kbEntryDetailSchema.parse(await kindRes.json());
  assert.equal(kindDetail.kind, "事实");
  assert.equal(kindDetail.userEdited, false);

  assert.equal((await call("PATCH", KB_API.patch("kb-rag"), {})).status, 422);
  assert.equal((await call("PATCH", KB_API.patch("kb-rag"), { mastery: 2 })).status, 422);
  assert.equal((await call("PATCH", KB_API.patch("kb-rag"), "{")).status, 400);
  assert.equal((await call("PATCH", KB_API.patch("kb-rag"), { categoryId: "nope" })).status, 422);
  assert.equal((await call("PATCH", KB_API.patch("missing"), { mastery: 0.1 })).status, 404);
});

test("GET impact + DELETE entries", async (t) => {
  const { call, appDb } = setup(t);
  const impactRes = await call("GET", `${KB_API.impact}?ids=kb-rerank,kb-bi`);
  assert.equal(impactRes.status, 200);
  const impact = kbDeleteImpactResponseSchema.parse(await impactRes.json());
  assert.equal(impact.entries.length, 2);
  assert.deepEqual(
    impact.reparentedChildren.map((c) => [c.id, c.newParentId]),
    [["kb-cross", "kb-rag"]]
  );
  assert.equal((await call("GET", `${KB_API.impact}?ids=`)).status, 422);
  assert.equal((await call("GET", `${KB_API.impact}?ids=missing`)).status, 404);

  const request: KbDeleteRequestInput = { ids: ["kb-rerank", "kb-bi"], ignore: true };
  const del = await call("DELETE", KB_API.delete, request);
  assert.equal(del.status, 200);
  const body = kbDeleteResponseSchema.parse(await del.json());
  assert.equal(body.deletedEntryCount, 2);
  assert.ok(appDb.db.prepare("SELECT 1 FROM trash WHERE id = ? AND kind = 'entries'").get(body.trashId));
  assert.equal((await call("GET", KB_API.entry("kb-rerank"))).status, 404);
  assert.equal((await call("DELETE", KB_API.delete, { ids: ["kb-rerank"] })).status, 404);
  assert.equal((await call("DELETE", KB_API.delete, { ids: [] })).status, 422);
});

test("deleted entries appear in the workbench trash and restore through it", async (t) => {
  const { call } = setup(t);
  const del = kbDeleteResponseSchema.parse(await (await call("DELETE", KB_API.delete, { ids: ["kb-rerank"], ignore: false })).json());

  const list = trashListResponseSchema.parse(await (await call("GET", TRASH_API.list)).json());
  const row = list.entries.find((entry) => entry.id === del.trashId);
  assert.ok(row);
  assert.equal(row.kind, "entries");
  assert.equal(row.title, "重排");
  assert.deepEqual(row.entryIds, ["kb-rerank"]);

  const restore = await call("POST", TRASH_API.restore(del.trashId));
  assert.equal(restore.status, 200);
  assert.equal(trashRestoreResponseSchema.parse(await restore.json()).restoredEntryCount, 1);
  assert.equal((await call("GET", KB_API.entry("kb-rerank"))).status, 200);
  const after = trashListResponseSchema.parse(await (await call("GET", TRASH_API.list)).json());
  assert.ok(!after.entries.some((entry) => entry.id === del.trashId));
});
