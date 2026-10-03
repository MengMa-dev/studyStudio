import type { DatabaseSync } from "node:sqlite";
import {
  KB_REWRITE_SUGGEST_PATCH_COUNT,
  kbCompletenessSchema,
  type InboxItemType,
  type KbBreadcrumb,
  type KbCompleteness,
  type KbEntryDetail,
  type KbEntrySource,
  type KbEvidence,
  type KbRelation,
  type KbRenderedSections,
  type NoteSummary
} from "@study-studio/shared";
import type { ItemType, KbEntryRow, NoteRow } from "../../db/types.js";
import type { MasterySignals } from "./mastery.js";
import {
  UNCATEGORIZED_NAME,
  loadAliveEntries,
  loadAliveEntry,
  loadCategories,
  loadMasterySignals,
  loadTreeLayout,
  masteryOf,
  normalizeKind,
  normalizeSourceKind,
  parentOf,
  parseAliases,
  parseJson,
  parseRelationType,
  signalsOf
} from "./queries.js";

const SAME_CATEGORY_LIMIT = 50;

type SourceRow = {
  item_id: string;
  evidence: string | null;
  source_kind: string | null;
  added_at: string | null;
  title: string | null;
  type: ItemType;
  url: string | null;
  site: string | null;
};

type EdgeRow = { src: string; dst: string; type: string };
type EdgeSourceRow = EdgeRow & { item_id: string | null; description: string | null };

function parseCompleteness(value: string | null): KbCompleteness | null {
  const parsed = kbCompletenessSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : null;
}

/** Stored as `[{ quote, question?, turn_item_id? }]` (02); camelCase is accepted too. */
export function parseEvidence(value: string | null): KbEvidence[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const evidence: KbEvidence[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.quote !== "string") continue;
    const item: KbEvidence = { quote: record.quote };
    if (typeof record.question === "string" && record.question.trim()) item.question = record.question;
    const turn = record.turn_item_id ?? record.turnItemId;
    if (typeof turn === "string" && turn) item.turnItemId = turn;
    evidence.push(item);
  }
  return evidence;
}

function toNoteSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    scope: row.scope,
    targetId: row.target_id,
    text: row.text,
    origin: row.origin,
    usedAt: row.used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function edgeKey(edge: EdgeRow): string {
  return JSON.stringify([edge.src, edge.dst, edge.type]);
}

function loadSources(db: DatabaseSync, entryId: string): KbEntrySource[] {
  const rows = db
    .prepare(
      `SELECT s.item_id, s.evidence, s.source_kind, s.added_at, i.title, i.type, i.url, i.site
         FROM kb_entry_sources s
         JOIN items i ON i.id = s.item_id AND i.deleted_at IS NULL
        WHERE s.entry_id = ?
        ORDER BY s.added_at IS NULL, s.added_at DESC, s.item_id`
    )
    .all(entryId) as SourceRow[];
  return rows.map((row) => ({
    itemId: row.item_id,
    title: row.title?.trim() || row.url || row.item_id,
    type: row.type as InboxItemType,
    url: row.url,
    site: row.site,
    sourceKind: normalizeSourceKind(row.source_kind),
    addedAt: row.added_at,
    evidence: parseEvidence(row.evidence)
  }));
}

function renderFaqs(sources: KbEntrySource[]): KbRenderedSections["faqs"] {
  const seen = new Set<string>();
  const faqs: KbRenderedSections["faqs"] = [];
  for (const source of sources) {
    for (const evidence of source.evidence) {
      const question = evidence.question?.trim();
      if (!question || seen.has(question)) continue;
      seen.add(question);
      faqs.push({ question, itemId: source.itemId, turnItemId: evidence.turnItemId ?? null });
    }
  }
  return faqs;
}

function breadcrumbOf(entry: KbEntryRow, categoryId: string | null, categoryName: string | null, names: Map<string, string>, db: DatabaseSync): KbBreadcrumb[] {
  const layout = loadTreeLayout(db);
  const ancestors: KbBreadcrumb[] = [];
  const visited = new Set<string>([entry.id]);
  let parentId = parentOf(layout, entry.id);
  while (parentId && !visited.has(parentId) && names.has(parentId)) {
    visited.add(parentId);
    ancestors.unshift({ type: "entry", id: parentId, name: names.get(parentId)! });
    parentId = parentOf(layout, parentId);
  }
  return [{ type: "category", id: categoryId, name: categoryName ?? UNCATEGORIZED_NAME }, ...ancestors, { type: "entry", id: entry.id, name: entry.name }];
}

export function getKbEntryDetail(db: DatabaseSync, id: string): KbEntryDetail | null {
  const entry = loadAliveEntry(db, id);
  if (!entry) return null;

  const categories = loadCategories(db);
  const category = entry.category_id ? (categories.get(entry.category_id) ?? null) : null;
  const signals: Map<string, MasterySignals> = loadMasterySignals(db);
  const alive = loadAliveEntries(db);
  const byId = new Map(alive.map((row) => [row.id, row]));
  const names = new Map(alive.map((row) => [row.id, row.name]));

  const edges = db.prepare("SELECT src, dst, type FROM kb_edges WHERE (src = ? OR dst = ?) AND src <> dst ORDER BY type, src, dst").all(id, id) as EdgeRow[];
  const edgeSources = db
    .prepare("SELECT src, dst, type, item_id, description FROM kb_edge_sources WHERE src = ? OR dst = ? ORDER BY rowid")
    .all(id, id) as EdgeSourceRow[];
  const sourcesByEdge = new Map<string, EdgeSourceRow[]>();
  for (const row of edgeSources) {
    const key = edgeKey(row);
    sourcesByEdge.set(key, [...(sourcesByEdge.get(key) ?? []), row]);
  }

  const relations: KbRelation[] = [];
  const contrasts: KbRenderedSections["contrasts"] = [];
  for (const edge of edges) {
    const type = parseRelationType(edge.type);
    const direction = edge.src === id ? "out" : "in";
    const other = byId.get(direction === "out" ? edge.dst : edge.src);
    if (!type || !other) continue;
    const provenance = sourcesByEdge.get(edgeKey(edge)) ?? [];
    const description = provenance.find((row) => row.description?.trim())?.description?.trim() ?? null;
    relations.push({ id: other.id, name: other.name, type, direction, mastery: masteryOf(other, signals), description });
    if (type === "contrasts" && description) {
      const sourceItemIds = [...new Set(provenance.map((row) => row.item_id).filter((itemId): itemId is string => Boolean(itemId)))];
      contrasts.push({ entryId: other.id, name: other.name, description, sourceItemIds });
    }
  }

  const sources = loadSources(db, id);
  const notes = (
    db.prepare("SELECT * FROM notes WHERE scope = 'entry' AND target_id = ? AND deleted_at IS NULL ORDER BY created_at, id").all(id) as NoteRow[]
  ).map(toNoteSummary);

  const categoryId = category?.id ?? null;
  const sameCategory = alive
    .filter((row) => row.id !== id && (categoryId ? row.category_id === categoryId : !row.category_id || !categories.has(row.category_id)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .slice(0, SAME_CATEGORY_LIMIT)
    .map((row) => ({ id: row.id, name: row.name, mastery: masteryOf(row, signals) }));

  const sourceCount = signalsOf(signals, id).sourceCount;
  const patchCount = Math.max(0, Number(entry.patch_count ?? 0));
  return {
    id: entry.id,
    name: entry.name,
    aliases: parseAliases(entry.aliases),
    kind: normalizeKind(entry.kind),
    categoryId,
    categoryName: category ? (category.name ?? "") : null,
    breadcrumb: breadcrumbOf(entry, categoryId, category ? (category.name ?? "") : null, names, db),
    summary: entry.summary,
    bodyMarkdown: entry.body_markdown ?? "",
    renderedSections: { contrasts, faqs: renderFaqs(sources) },
    completeness: parseCompleteness(entry.completeness),
    mastery: masteryOf(entry, signals),
    masterySource: entry.mastery_source === "user" ? "user" : "auto",
    userEdited: Boolean(entry.user_edited),
    dirty: Boolean(entry.dirty),
    stale: Boolean(entry.stale),
    orphan: Boolean(entry.orphan) || sourceCount === 0,
    patchCount,
    suggestRewrite: patchCount >= KB_REWRITE_SUGGEST_PATCH_COUNT,
    updatedAt: entry.updated_at,
    notes,
    sources,
    relations,
    sameCategory
  };
}
