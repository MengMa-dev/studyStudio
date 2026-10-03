import type { DatabaseSync } from "node:sqlite";
import type { InboxItemType, KbCompleteness, KbRelationType } from "@study-studio/shared";
import type { AiGateway } from "../../../ai/gateway.js";
import type { ItemRow } from "../../../db/types.js";
import { searchFts } from "../../../search/fts.js";
import { hybridSearch } from "../../../search/hybrid.js";
import type { SearchIndex } from "../../../search/index-api.js";
import { getKbEntryDetail } from "../../kb/detail.js";
import { FAMILIAR_MASTERY_THRESHOLD, WEAK_MASTERY_THRESHOLD } from "../../kb/mastery.js";
import { loadAliveEntries, loadCategories, loadMasterySignals, masteryOf } from "../../kb/queries.js";
import { selectIn } from "../../inbox/sql.js";
import { ENTRY_OWNER } from "../../organize/runtime-types.js";
import type { CitationRegistry } from "../contracts.js";
import { DETAIL_TEXT_LIMIT, roundMastery, snippet, truncate } from "./text.js";

export const SEARCH_DEFAULT_K = 6;
export const SEARCH_MAX_K = 8;
const ENTRY_LINK_LIMIT = 20;
export const MASTERY_LIST_DEFAULT_LIMIT = 20;
export const MASTERY_LIST_MAX_LIMIT = 50;

const ENTRY_OWNER_TYPES = new Set<string>(Object.values(ENTRY_OWNER));
const ITEM_OWNER_TYPE = "item";

type Hit = { ownerType: string; ownerId: string; text: string };

export type SearchEntryResult = {
  ref: number;
  kind: "entry";
  id: string;
  name: string;
  summary: string | null;
  category: string | null;
  mastery: number | null;
  snippet: string;
};
export type SearchItemResult = { ref: number; kind: "item"; id: string; title: string; type: InboxItemType; snippet: string };
export type SearchToolResult =
  { results: (SearchEntryResult | SearchItemResult)[]; retrieval: "hybrid" | "fts" } | { results: []; retrieval: "hybrid" | "fts"; note: "no_match" };

export type SearchDeps = { db: DatabaseSync; searchIndex?: SearchIndex; aiGateway?: AiGateway };

async function recall(deps: SearchDeps, query: string, limit: number, signal?: AbortSignal): Promise<{ hits: Hit[]; retrieval: "hybrid" | "fts" }> {
  if (deps.aiGateway && deps.searchIndex) {
    try {
      const { embedding } = await deps.aiGateway.embed({ value: query.slice(0, 8000), abortSignal: signal });
      return { hits: hybridSearch(deps.db, deps.searchIndex.vectorStore, { text: query, embedding }, { limit, anyToken: true }), retrieval: "hybrid" };
    } catch {
      // Embedding not configured / failed / dimension mismatch: keyword search still answers.
    }
  }
  return { hits: searchFts(deps.db, query, { limit, anyToken: true }), retrieval: "fts" };
}

/** Hits come best-first; the first chunk per owner wins, preferring summary / body text over the bare name chunk. */
function groupByOwner(hits: Hit[]): Map<string, { kind: "entry" | "item"; id: string; text: string }> {
  const owners = new Map<string, { kind: "entry" | "item"; id: string; text: string; nameOnly: boolean }>();
  for (const hit of hits) {
    const kind = ENTRY_OWNER_TYPES.has(hit.ownerType) ? "entry" : hit.ownerType === ITEM_OWNER_TYPE ? "item" : null;
    if (!kind) continue;
    const key = `${kind}:${hit.ownerId}`;
    const nameOnly = hit.ownerType === ENTRY_OWNER.name;
    const current = owners.get(key);
    if (!current) owners.set(key, { kind, id: hit.ownerId, text: hit.text, nameOnly });
    else if (current.nameOnly && !nameOnly) owners.set(key, { ...current, text: hit.text, nameOnly });
  }
  return owners;
}

export async function searchKnowledge(
  deps: SearchDeps,
  registry: CitationRegistry,
  input: { query: string; k?: number },
  signal?: AbortSignal
): Promise<SearchToolResult> {
  const k = Math.min(SEARCH_MAX_K, Math.max(1, input.k ?? SEARCH_DEFAULT_K));
  const { hits, retrieval } = await recall(deps, input.query, k * 4, signal);
  const owners = [...groupByOwner(hits).values()];

  const entries = new Map(
    loadAliveEntries(
      deps.db,
      owners.filter((owner) => owner.kind === "entry").map((owner) => owner.id)
    ).map((row) => [row.id, row])
  );
  const items = new Map(
    selectIn<ItemRow>(
      deps.db,
      (list) => `SELECT * FROM items WHERE deleted_at IS NULL AND id IN (${list})`,
      owners.filter((owner) => owner.kind === "item").map((owner) => owner.id)
    ).map((row) => [row.id, row])
  );
  const signals = entries.size > 0 ? loadMasterySignals(deps.db) : new Map();
  const categories = entries.size > 0 ? loadCategories(deps.db) : new Map();

  const results: (SearchEntryResult | SearchItemResult)[] = [];
  for (const owner of owners) {
    if (results.length >= k) break;
    if (owner.kind === "entry") {
      const row = entries.get(owner.id);
      if (!row) continue;
      results.push({
        ref: registry.register({ kind: "entry", id: row.id, title: row.name }),
        kind: "entry",
        id: row.id,
        name: row.name,
        summary: row.summary,
        category: row.category_id ? (categories.get(row.category_id)?.name ?? null) : null,
        mastery: roundMastery(masteryOf(row, signals)),
        snippet: snippet(owner.text)
      });
    } else {
      const row = items.get(owner.id);
      if (!row) continue;
      const title = row.title ?? row.url ?? row.id;
      results.push({
        ref: registry.register({ kind: "item", id: row.id, title }),
        kind: "item",
        id: row.id,
        title,
        type: row.type as InboxItemType,
        snippet: snippet(owner.text)
      });
    }
  }
  return results.length > 0 ? { results, retrieval } : { results: [], retrieval, note: "no_match" };
}

export type EntryToolResult =
  | {
      ref: number;
      id: string;
      name: string;
      aliases: string[];
      category: string | null;
      summary: string | null;
      body: string;
      bodyTruncated: boolean;
      mastery: number | null;
      completeness: KbCompleteness | null;
      relations: { ref: number; id: string; name: string; type: KbRelationType; direction: "out" | "in"; mastery: number | null; description: string | null }[];
      sources: { ref: number; itemId: string; title: string; type: InboxItemType; url: string | null }[];
    }
  | { error: "not_found"; id: string };

export function getEntry(db: DatabaseSync, registry: CitationRegistry, id: string): EntryToolResult {
  const detail = getKbEntryDetail(db, id);
  if (!detail) return { error: "not_found", id };
  const ref = registry.register({ kind: "entry", id: detail.id, title: detail.name });
  const body = truncate(detail.bodyMarkdown, DETAIL_TEXT_LIMIT);
  return {
    ref,
    id: detail.id,
    name: detail.name,
    aliases: detail.aliases,
    category: detail.categoryName,
    summary: detail.summary,
    body: body.text,
    bodyTruncated: body.truncated,
    mastery: roundMastery(detail.mastery),
    completeness: detail.completeness,
    relations: detail.relations.slice(0, ENTRY_LINK_LIMIT).map((relation) => ({
      ref: registry.register({ kind: "entry", id: relation.id, title: relation.name }),
      id: relation.id,
      name: relation.name,
      type: relation.type,
      direction: relation.direction,
      mastery: roundMastery(relation.mastery),
      description: relation.description
    })),
    sources: detail.sources.slice(0, ENTRY_LINK_LIMIT).map((source) => ({
      ref: registry.register({ kind: "item", id: source.itemId, title: source.title }),
      itemId: source.itemId,
      title: source.title,
      type: source.type,
      url: source.url
    }))
  };
}

export type MasteryLevel = "weak" | "familiar";

export type MasteryToolResult = {
  level: MasteryLevel;
  threshold: number;
  total: number;
  entries: { ref: number; id: string; name: string; mastery: number; category: string | null }[];
  note?: "no_entries";
};

/** weak: effective mastery < {@link WEAK_MASTERY_THRESHOLD}, weakest first; familiar: ≥ {@link FAMILIAR_MASTERY_THRESHOLD}, strongest first. Unestimated entries are skipped. */
export function listMastery(db: DatabaseSync, registry: CitationRegistry, input: { level: MasteryLevel; limit?: number }): MasteryToolResult {
  const limit = Math.min(MASTERY_LIST_MAX_LIMIT, Math.max(1, input.limit ?? MASTERY_LIST_DEFAULT_LIMIT));
  const weak = input.level === "weak";
  const threshold = weak ? WEAK_MASTERY_THRESHOLD : FAMILIAR_MASTERY_THRESHOLD;
  const signals = loadMasterySignals(db);
  const categories = loadCategories(db);
  const matched = loadAliveEntries(db)
    .map((row) => ({ row, mastery: masteryOf(row, signals) }))
    .filter((entry): entry is { row: (typeof entry)["row"]; mastery: number } =>
      entry.mastery === null ? false : weak ? entry.mastery < threshold : entry.mastery >= threshold
    )
    .sort((a, b) => (weak ? a.mastery - b.mastery : b.mastery - a.mastery) || a.row.name.localeCompare(b.row.name, "zh-Hans-CN"));
  const entries = matched.slice(0, limit).map(({ row, mastery }) => ({
    ref: registry.register({ kind: "entry", id: row.id, title: row.name }),
    id: row.id,
    name: row.name,
    mastery: roundMastery(mastery)!,
    category: row.category_id ? (categories.get(row.category_id)?.name ?? null) : null
  }));
  const result: MasteryToolResult = { level: input.level, threshold, total: matched.length, entries };
  if (entries.length === 0) result.note = "no_entries";
  return result;
}
