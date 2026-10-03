import type { DatabaseSync } from "node:sqlite";
import { estimateTokens } from "../../search/chunk.js";
import { vectorRecall, type IndexContext } from "./kb-index.js";
import { tryEmbed } from "./llm.js";
import { normalizeEntryName } from "./normalize.js";
import { ENTRY_OWNER } from "./runtime-types.js";
import { computeSimhash } from "./simhash.js";
import { lastSourceAt, type EntryRecord, type OrganizeItem } from "./store.js";
import type { RelatedCandidate, SourceFingerprint } from "./types.js";

/** ④ Retrieve: item-level + episode-level recall over entry vectors, plus exact name / alias matching. */

/** Similarity assigned to an exact name / alias hit (above the 0.55 cut, below the 0.93 duplicate rule). */
export const NAME_MATCH_SIMILARITY = 0.7;
const QUERY_HEAD_TOKENS = 500;

export type EpisodeQuery = { key: string; topic: string | null; learningGoal: string | null; relatedExploration: string[] };

function headByTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  let end = Math.min(text.length, tokens * 2);
  while (end > 0 && estimateTokens(text.slice(0, end)) > tokens) end = Math.floor(end * 0.8);
  return text.slice(0, end);
}

/** Item-level query: title + highlights + body head; Q&A: questions + answer head. */
export function itemQueryText(items: OrganizeItem[]): string {
  const [first] = items;
  if (!first) return "";
  if (first.type === "conversation") {
    const questions = items.map((item) => item.question ?? item.title).join("\n");
    return [questions, headByTokens(items.map((item) => item.body).join("\n\n"), QUERY_HEAD_TOKENS)].join("\n");
  }
  return [first.title, ...first.highlights, headByTokens(first.body, QUERY_HEAD_TOKENS)].filter(Boolean).join("\n");
}

export class RetrievalCache {
  private readonly episodeVectors = new Map<string, number[] | null>();

  async episodeVector(ctx: IndexContext, query: EpisodeQuery): Promise<number[] | null> {
    if (this.episodeVectors.has(query.key)) return this.episodeVectors.get(query.key) ?? null;
    const text = [query.topic, query.learningGoal, ...query.relatedExploration].filter(Boolean).join("\n");
    const vector = text ? await tryEmbed(ctx.llm, text) : null;
    this.episodeVectors.set(query.key, vector);
    return vector;
  }
}

export async function retrieveCandidates(
  ctx: IndexContext,
  cache: RetrievalCache,
  items: OrganizeItem[],
  episode: EpisodeQuery | null,
  entries: EntryRecord[],
  now: Date
): Promise<RelatedCandidate[]> {
  const scores = new Map<string, number>();
  const bump = (id: string, similarity: number) => {
    if (similarity > (scores.get(id) ?? -1)) scores.set(id, similarity);
  };
  const owners = [ENTRY_OWNER.summary, ENTRY_OWNER.body];
  const itemVector = await tryEmbed(ctx.llm, itemQueryText(items));
  if (itemVector) for (const [id, similarity] of vectorRecall(ctx, itemVector, owners)) bump(id, similarity);
  if (episode) {
    const episodeVector = await cache.episodeVector(ctx, episode);
    if (episodeVector) for (const [id, similarity] of vectorRecall(ctx, episodeVector, owners)) bump(id, similarity);
  }

  const terms = new Set([...(episode?.relatedExploration ?? []), episode?.topic ?? "", items[0]?.title ?? ""].map(normalizeEntryName).filter(Boolean));
  for (const entry of entries) {
    const keys = [entry.name, ...entry.aliases].map(normalizeEntryName);
    if (keys.some((key) => terms.has(key))) bump(entry.id, NAME_MATCH_SIMILARITY);
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const candidates: RelatedCandidate[] = [];
  for (const [id, similarity] of scores) {
    const entry = byId.get(id);
    if (!entry) continue;
    candidates.push({
      entry_id: id,
      name: entry.name,
      summary: entry.summary ?? undefined,
      similarity,
      last_source_at: lastSourceAt(ctx.db, id) ?? entry.updatedAt ?? now.toISOString(),
      mastery: entry.mastery
    });
  }
  return candidates;
}

type FingerprintRow = { entryId: string; itemId: string; contentHash: string | null; simhash: bigint | null };

/** Fingerprints of already-ingested sources for the near-duplicate rule; grows as items are integrated. */
export class FingerprintCache {
  private readonly rows: FingerprintRow[] = [];

  constructor(db: DatabaseSync) {
    const sources = db
      .prepare(
        `SELECT s.entry_id, s.item_id, i.content_hash, c.markdown, c.plain_text FROM kb_entry_sources s
         JOIN items i ON i.id = s.item_id AND i.deleted_at IS NULL
         JOIN kb_entries e ON e.id = s.entry_id AND e.deleted_at IS NULL
         LEFT JOIN item_contents c ON c.item_id = s.item_id`
      )
      .all() as Array<{ entry_id: string; item_id: string; content_hash: string | null; markdown: string | null; plain_text: string | null }>;
    const simhashByItem = new Map<string, bigint | null>();
    for (const source of sources) {
      if (!simhashByItem.has(source.item_id)) {
        const text = (source.markdown || source.plain_text || "").trim();
        simhashByItem.set(source.item_id, text ? computeSimhash(text) : null);
      }
      this.rows.push({
        entryId: source.entry_id,
        itemId: source.item_id,
        contentHash: source.content_hash,
        simhash: simhashByItem.get(source.item_id) ?? null
      });
    }
  }

  add(entryId: string, item: OrganizeItem): void {
    this.rows.push({ entryId, itemId: item.id, contentHash: item.contentHash, simhash: item.body ? computeSimhash(item.body) : null });
  }

  /** Excludes the items being processed so re-organizing an item never matches its own source. */
  list(excludeItemIds: string[]): SourceFingerprint[] {
    const exclude = new Set(excludeItemIds);
    return this.rows.filter((row) => !exclude.has(row.itemId)).map((row) => ({ entry_id: row.entryId, content_hash: row.contentHash, simhash: row.simhash }));
  }
}
