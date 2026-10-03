import { searchFts, type FtsHit, type FtsSearchDb } from "./fts";
import type { VectorStore } from "./vectors";

export type HybridHit = {
  chunkId: string;
  rowid: number;
  ownerType: string;
  ownerId: string;
  text: string;
  /** Merged score before time-decay (organize ④ applies recency separately). */
  score: number;
  sources: ("vector" | "fts")[];
  vectorScore?: number;
  ftsScore?: number;
  ftsMode?: FtsHit["mode"];
};

export type HybridSearchOptions = {
  limit?: number;
  ownerType?: string;
  /** Minimum vector score to keep (default 0 — organize ④ applies 0.55 later). */
  minVectorScore?: number;
  /** See `searchFts` `anyToken`. */
  anyToken?: boolean;
};

type ChunkRow = {
  id: string;
  rowid: number;
  owner_type: string;
  owner_id: string;
  text: string;
};

/**
 * Two-path recall for organize ④: vector KNN + FTS (phrase → trigram/LIKE).
 * Time-decay scoring is intentionally left to the organize agent.
 */
export function hybridSearch(
  db: FtsSearchDb,
  vectorStore: VectorStore,
  query: { text: string; embedding: number[] },
  options: HybridSearchOptions = {}
): HybridHit[] {
  const limit = options.limit ?? 10;
  const fetchK = Math.max(limit * 3, 20);

  const vectorHits = vectorStore.search(query.embedding, fetchK);
  const ftsHits = searchFts(db, query.text, { limit: fetchK, ownerType: options.ownerType, anyToken: options.anyToken });

  const byRowid = new Map<number, HybridHit>();

  const loadChunk = (rowid: number): ChunkRow | null => {
    const row = db.prepare("SELECT id, rowid, owner_type, owner_id, text FROM chunks WHERE rowid = ?").get(rowid) as ChunkRow | undefined;
    return row ?? null;
  };

  for (const hit of vectorHits) {
    if (options.minVectorScore != null && hit.score < options.minVectorScore) continue;
    const chunk = loadChunk(hit.rowid);
    if (!chunk) continue;
    if (options.ownerType && chunk.owner_type !== options.ownerType) continue;
    byRowid.set(hit.rowid, {
      chunkId: chunk.id,
      rowid: hit.rowid,
      ownerType: chunk.owner_type,
      ownerId: chunk.owner_id,
      text: chunk.text,
      score: hit.score,
      sources: ["vector"],
      vectorScore: hit.score
    });
  }

  // Normalize FTS scores into 0..1 via rank among results.
  const maxFts = Math.max(...ftsHits.map((h) => h.score), 1e-9);
  for (const hit of ftsHits) {
    const ftsScore = hit.score / maxFts;
    const existing = byRowid.get(hit.rowid);
    if (existing) {
      existing.sources.push("fts");
      existing.ftsScore = ftsScore;
      existing.ftsMode = hit.mode;
      existing.score = Math.max(existing.score, ftsScore) + 0.05; // small bonus for dual hit
    } else {
      byRowid.set(hit.rowid, {
        chunkId: hit.chunkId,
        rowid: hit.rowid,
        ownerType: hit.ownerType,
        ownerId: hit.ownerId,
        text: hit.text,
        score: ftsScore,
        sources: ["fts"],
        ftsScore,
        ftsMode: hit.mode
      });
    }
  }

  return [...byRowid.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
