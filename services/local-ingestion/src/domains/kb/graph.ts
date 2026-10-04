import type { DatabaseSync } from "node:sqlite";
import type { KbGraphResponse } from "@study-studio/shared";
import { loadAliveEntries, loadCategories, loadMasterySignals, masteryOf, normalizeKind, parseRelationType, signalsOf } from "./queries.js";

/** GET /v1/kb/graph: every alive entry plus the edges between them; only categories that have nodes. */
export function getKbGraph(db: DatabaseSync): KbGraphResponse {
  const categories = loadCategories(db);
  const signals = loadMasterySignals(db);
  const nodes = loadAliveEntries(db).map((row) => ({
    id: row.id,
    name: row.name,
    kind: normalizeKind(row.kind),
    categoryId: row.category_id && categories.has(row.category_id) ? row.category_id : null,
    mastery: masteryOf(row, signals),
    stale: Boolean(row.stale),
    orphan: Boolean(row.orphan) || signalsOf(signals, row.id).sourceCount === 0
  }));
  const alive = new Set(nodes.map((node) => node.id));
  const used = new Set(nodes.map((node) => node.categoryId));
  const edges: KbGraphResponse["edges"] = [];
  for (const row of db.prepare("SELECT src, dst, type FROM kb_edges").all() as { src: string; dst: string; type: string }[]) {
    const type = parseRelationType(row.type);
    if (type && row.src !== row.dst && alive.has(row.src) && alive.has(row.dst)) edges.push({ src: row.src, dst: row.dst, type });
  }
  return {
    categories: [...categories.values()].filter((category) => used.has(category.id)).map((category) => ({ id: category.id, name: category.name ?? "" })),
    nodes,
    edges
  };
}
