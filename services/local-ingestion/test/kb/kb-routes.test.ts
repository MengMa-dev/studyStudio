import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KB_API,
  kbDeleteImpactResponseSchema,
  kbDeleteResponseSchema,
  kbEntryDetailSchema,
  kbTreeResponseSchema,
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

  const flat = kbTreeResponseSchema.parse(await (await call("GET", `${KB_API.tree}?q=${encodeURIComponent("重排")}&kind=method`)).json());
  assert.equal(flat.mode, "flat");
  assert.deepEqual(
    flat.entries.map((e) => e.id),
    ["kb-rerank"]
  );
  assert.equal((await call("GET", `${KB_API.tree}?kind=bogus`)).status, 422);
  assert.equal(kbTreeResponseSchema.parse(await (await call("GET", `${KB_API.tree}?q=`)).json()).mode, "tree");
});

test("GET entry detail and 404", async (t) => {
  const { call } = setup(t);
  const res = await call("GET", KB_API.entry("kb-cross"));
  assert.equal(res.status, 200);
  const detail = kbEntryDetailSchema.parse(await res.json());
  assert.equal(detail.renderedSections.faqs.length, 1);
  assert.equal((await call("GET", KB_API.entry("missing"))).status, 404);
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
