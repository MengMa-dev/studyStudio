import type { DatabaseSync } from "node:sqlite";
import type { KbFlatEntry, KbTreeCategoryNode, KbTreeEntryNode, KbTreeQuery, KbTreeResponse } from "@study-studio/shared";
import type { KbEntryRow } from "../../db/types.js";
import { WEAK_MASTERY_THRESHOLD } from "./mastery.js";
import {
  UNCATEGORIZED_NAME,
  loadAliveEntries,
  loadCategories,
  loadMasterySignals,
  loadTreeLayout,
  masteryOf,
  normalizeKind,
  parentOf,
  parseAliases,
  signalsOf
} from "./queries.js";

type EntryView = Omit<KbTreeEntryNode, "children"> & { categoryId: string | null };

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

function buildViews(db: DatabaseSync, rows: KbEntryRow[], knownCategories: Set<string>): Map<string, EntryView> {
  const signals = loadMasterySignals(db);
  const views = new Map<string, EntryView>();
  for (const row of rows) {
    const sourceCount = signalsOf(signals, row.id).sourceCount;
    views.set(row.id, {
      id: row.id,
      name: row.name,
      aliases: parseAliases(row.aliases),
      kind: normalizeKind(row.kind),
      summary: row.summary,
      mastery: masteryOf(row, signals),
      masterySource: row.mastery_source === "user" ? "user" : "auto",
      stale: Boolean(row.stale),
      userEdited: Boolean(row.user_edited),
      orphan: Boolean(row.orphan) || sourceCount === 0,
      sourceCount,
      categoryId: row.category_id && knownCategories.has(row.category_id) ? row.category_id : null
    });
  }
  return views;
}

function matchesQuery(view: EntryView, query: KbTreeQuery): boolean {
  if (query.kind && view.kind !== query.kind) return false;
  const needle = query.q?.trim().toLowerCase();
  if (!needle) return true;
  return [view.name, ...view.aliases].some((name) => name.toLowerCase().includes(needle));
}

/** GET /v1/kb/tree: categories with `part_of` nesting, or a flat list when `q` / `kind` is set. */
export function getKbTree(db: DatabaseSync, query: KbTreeQuery = {}): KbTreeResponse {
  const categories = loadCategories(db);
  const rows = loadAliveEntries(db);
  const views = buildViews(db, rows, new Set(categories.keys()));

  if (query.q?.trim() || query.kind) {
    const entries: KbFlatEntry[] = [...views.values()]
      .filter((view) => matchesQuery(view, query))
      .sort(byName)
      .map((view) => ({ ...view, categoryName: view.categoryId ? (categories.get(view.categoryId)?.name ?? "") : null }));
    return { mode: "flat", categories: [], entries, total: entries.length };
  }

  const layout = loadTreeLayout(db);
  const childrenOf = new Map<string | null, EntryView[]>();
  const rootsByCategory = new Map<string | null, EntryView[]>();
  for (const view of views.values()) {
    const parentId = parentOf(layout, view.id);
    if (parentId && views.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(view);
      childrenOf.set(parentId, list);
    } else {
      const list = rootsByCategory.get(view.categoryId) ?? [];
      list.push(view);
      rootsByCategory.set(view.categoryId, list);
    }
  }

  const toNode = (view: EntryView): KbTreeEntryNode => {
    return {
      id: view.id,
      name: view.name,
      aliases: view.aliases,
      kind: view.kind,
      summary: view.summary,
      mastery: view.mastery,
      masterySource: view.masterySource,
      stale: view.stale,
      userEdited: view.userEdited,
      orphan: view.orphan,
      sourceCount: view.sourceCount,
      children: (childrenOf.get(view.id) ?? []).sort(byName).map(toNode)
    };
  };

  const categoryNode = (id: string | null, name: string, description: string | null): KbTreeCategoryNode => {
    const members = [...views.values()].filter((view) => view.categoryId === id);
    const scored = members.map((view) => view.mastery).filter((mastery): mastery is number => mastery !== null);
    return {
      id,
      name,
      description,
      entryCount: members.length,
      avgMastery: scored.length ? Math.round((scored.reduce((sum, mastery) => sum + mastery, 0) / scored.length) * 1000) / 1000 : null,
      weakEntryCount: scored.filter((mastery) => mastery < WEAK_MASTERY_THRESHOLD).length,
      children: (rootsByCategory.get(id) ?? []).sort(byName).map(toNode)
    };
  };

  const categoryNodes = [...categories.values()].map((category) => categoryNode(category.id, category.name ?? "", category.description));
  if (rootsByCategory.has(null)) categoryNodes.push(categoryNode(null, UNCATEGORIZED_NAME, null));
  return { mode: "tree", categories: categoryNodes, entries: [], total: views.size };
}
