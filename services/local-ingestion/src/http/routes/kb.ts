import type { Hono } from "hono";
import { kbDeleteImpactQuerySchema, kbDeleteRequestSchema, kbEntryPatchSchema, kbKindRenameSchema, kbTreeQuerySchema } from "@study-studio/shared";
import type { AppServices } from "../app.js";
import {
  deleteKbEntries,
  getKbDeleteImpact,
  getKbEntryDetail,
  getKbGraph,
  getKbTree,
  listKbKinds,
  parseIdList,
  patchKbEntry,
  renameKbKind
} from "../../domains/kb/index.js";

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** KB_API (08). */
export function registerKbRoutes(api: Hono, services: AppServices): void {
  const db = services.appDb.db;

  api.get("/kb/tree", (c) => {
    const parsed = kbTreeQuerySchema.safeParse({ q: c.req.query("q") || undefined, kind: c.req.query("kind") || undefined });
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_query" }, 422);
    return c.json(getKbTree(db, parsed.data));
  });

  api.get("/kb/kinds", (c) => c.json(listKbKinds(db)));

  api.patch("/kb/kinds", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = kbKindRenameSchema.safeParse(json.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_request" }, 422);
    return c.json(renameKbKind(db, parsed.data, new Date().toISOString()));
  });

  api.get("/kb/graph", (c) => c.json(getKbGraph(db)));

  // Must precede `/kb/entries/:id`.
  api.get("/kb/entries/impact", (c) => {
    const parsed = kbDeleteImpactQuerySchema.safeParse({ ids: c.req.query("ids") ?? "" });
    const ids = parsed.success ? parseIdList(parsed.data.ids) : [];
    if (ids.length === 0) return c.json({ error: "ids is required" }, 422);
    const impact = getKbDeleteImpact(db, ids);
    if (!impact) return c.json({ error: "not_found" }, 404);
    return c.json(impact);
  });

  api.get("/kb/entries/:id", (c) => {
    const detail = getKbEntryDetail(db, c.req.param("id"));
    if (!detail) return c.json({ error: "not_found" }, 404);
    return c.json(detail);
  });

  api.patch("/kb/entries/:id", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = kbEntryPatchSchema.safeParse(json.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_patch" }, 422);
    const result = await patchKbEntry(db, c.req.param("id"), parsed.data, { searchIndex: services.searchIndex });
    if (result.status === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.status === "category_not_found") return c.json({ error: "category_not_found" }, 422);
    return c.json(result.detail);
  });

  api.delete("/kb/entries", async (c) => {
    const json = await readJson(c);
    if (!json.ok) return c.json({ error: "invalid_json" }, 400);
    const parsed = kbDeleteRequestSchema.safeParse(json.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_request" }, 422);
    const result = deleteKbEntries(db, parsed.data, { searchIndex: services.searchIndex });
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json(result);
  });
}
