import { test } from "node:test";
import assert from "node:assert/strict";
import { KB_API, kbGraphResponseSchema, kbTreeResponseSchema, type KbTreeEntryNode } from "@study-studio/shared";
import { PresenceStore } from "../../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../../src/http/app.js";
import { seedKb } from "./seed.js";

const port = 43120;

test("GET graph filters dead / invalid edges, nulls unknown categories, matches tree mastery", async (t) => {
  const appDb = seedKb();
  t.after(() => appDb.close());
  const db = appDb.db;
  db.prepare("INSERT INTO kb_categories (id, name, sort) VALUES ('cat-empty', '空分类', 3)").run();
  db.prepare(
    "INSERT INTO kb_entries (id, name, category_id, kind, updated_at) VALUES ('kb-lost', '失联词条', 'cat-dead', 'concept', '2026-10-01T00:00:00.000Z')"
  ).run();
  db.prepare("INSERT INTO kb_edges (src, dst, type) VALUES ('kb-rag', 'kb-rag', 'related'), ('kb-rag', 'kb-bi', 'bogus')").run();

  const app = createApp({
    appDb,
    auth: createAuthState("tok", port),
    presence: new PresenceStore(),
    ingestCtx: { app: appDb },
    getPort: () => port,
    workbenchDist: "/nonexistent-workbench-dist"
  });
  const get = async (path: string) =>
    (await app.request(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}`, authorization: "Bearer tok" } })).json();

  const graph = kbGraphResponseSchema.parse(await get(KB_API.graph));
  const ids = graph.nodes.map((node) => node.id);
  assert.ok(!ids.includes("kb-gone"));
  assert.ok(graph.edges.every((edge) => edge.src !== "kb-gone" && edge.dst !== "kb-gone"));
  assert.ok(!graph.edges.some((edge) => edge.src === edge.dst || (edge.type as string) === "bogus"));
  assert.equal(graph.edges.length, 5);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("kb-misc")!.categoryId, null);
  assert.equal(byId.get("kb-lost")!.categoryId, null);
  assert.equal(byId.get("kb-agent")!.orphan, true);
  assert.deepEqual(
    graph.categories.map((category) => category.id),
    ["cat-rag", "cat-agent"]
  );

  const tree = kbTreeResponseSchema.parse(await get(KB_API.tree));
  const walk = (nodes: KbTreeEntryNode[]): KbTreeEntryNode[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
  const treeEntries = walk(tree.categories.flatMap((category) => category.children));
  assert.equal(treeEntries.length, graph.nodes.length);
  for (const entry of treeEntries) assert.equal(byId.get(entry.id)!.mastery, entry.mastery, entry.id);
});
