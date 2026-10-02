import { queryCharLength, segmentText, tokenize } from "./segment";

export type FtsQueryMode = "phrase" | "trigram" | "like";

export type FtsQueryPlan = {
  /** Primary: Segmenter-presegmented phrase MATCH against chunks_fts. */
  phrase: string | null;
  /** Fallback when query < 3 chars or phrase yields no hits. */
  trigram: string | null;
  /** Ultimate fallback for queries trigram cannot MATCH (< 3 chars). */
  like: string | null;
  /** Why fallback may be needed. */
  shortQuery: boolean;
  tokens: string[];
};

function escapeFtsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Build FTS query variants following M0 conclusion:
 * same Segmenter tokenization + phrase match; when query < 3 chars or no hits, fall back to trigram / LIKE.
 */
export function buildFtsQueryPlan(query: string): FtsQueryPlan {
  const trimmed = query.trim();
  const tokens = tokenize(trimmed);
  const segmented = segmentText(trimmed);
  const shortQuery = queryCharLength(trimmed) < 3;

  const phrase = segmented.length > 0 ? escapeFtsPhrase(segmented) : null;
  // Trigram MATCH needs ≥ 3 characters in the query string.
  const trigram = !shortQuery && trimmed.length >= 3 ? escapeFtsPhrase(trimmed.toLowerCase()) : null;
  const like = trimmed.length > 0 ? `%${trimmed.replaceAll("%", "").replaceAll("_", "")}%` : null;

  return { phrase, trigram, like, shortQuery, tokens };
}

/** Minimal DB surface — compatible with node:sqlite DatabaseSync. */
export type SqlStatement = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (...params: any[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all: (...params: any[]) => unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (...params: any[]) => unknown;
};

export type FtsSearchDb = {
  prepare: (sql: string) => Pick<SqlStatement, "all" | "get">;
};

export type FtsHit = {
  chunkId: string;
  rowid: number;
  ownerType: string;
  ownerId: string;
  text: string;
  score: number;
  mode: FtsQueryMode;
};

/**
 * Run phrase FTS first; if short query or empty, fall back to trigram then LIKE.
 * `chunks_fts` / `chunks_trigram` rowids must align with `chunks.rowid`.
 */
export function searchFts(db: FtsSearchDb, query: string, options: { limit?: number; ownerType?: string } = {}): FtsHit[] {
  const limit = options.limit ?? 20;
  const plan = buildFtsQueryPlan(query);
  const ownerFilter = options.ownerType ? "AND c.owner_type = ?" : "";

  const mapRows = (rows: unknown[], mode: FtsQueryMode): FtsHit[] =>
    (rows as { id: string; rowid: number; owner_type: string; owner_id: string; text: string; rank: number }[]).map((row) => ({
      chunkId: row.id,
      rowid: Number(row.rowid),
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      text: row.text,
      score: -row.rank,
      mode
    }));

  if (plan.phrase && !plan.shortQuery) {
    const sql = `
      SELECT c.id, c.rowid AS rowid, c.owner_type, c.owner_id, c.text, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ? ${ownerFilter}
      ORDER BY rank
      LIMIT ?`;
    const params = options.ownerType ? [plan.phrase, options.ownerType, limit] : [plan.phrase, limit];
    const hits = mapRows(db.prepare(sql).all(...params), "phrase");
    if (hits.length > 0) return hits;
  }

  if (plan.trigram) {
    const sql = `
      SELECT c.id, c.rowid AS rowid, c.owner_type, c.owner_id, c.text, bm25(chunks_trigram) AS rank
      FROM chunks_trigram
      JOIN chunks c ON c.rowid = chunks_trigram.rowid
      WHERE chunks_trigram MATCH ? ${ownerFilter}
      ORDER BY rank
      LIMIT ?`;
    const params = options.ownerType ? [plan.trigram, options.ownerType, limit] : [plan.trigram, limit];
    const hits = mapRows(db.prepare(sql).all(...params), "trigram");
    if (hits.length > 0) return hits;
  }

  if (plan.like) {
    // Prefer trigram table's contentless companion via chunks.text LIKE for short queries.
    const sql = `
      SELECT c.id, c.rowid AS rowid, c.owner_type, c.owner_id, c.text, 0 AS rank
      FROM chunks c
      WHERE c.text LIKE ? ${ownerFilter}
      LIMIT ?`;
    const params = options.ownerType ? [plan.like, options.ownerType, limit] : [plan.like, limit];
    return mapRows(db.prepare(sql).all(...params), "like");
  }

  return [];
}
