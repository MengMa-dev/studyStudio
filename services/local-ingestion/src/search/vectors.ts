import { getLoadablePath } from "sqlite-vec";

import type { SqlStatement } from "./fts";

export type VectorDb = {
  loadExtension: (path: string) => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqlStatement;
};

export type VectorHit = {
  rowid: number;
  distance: number;
  /** cosine similarity ≈ 1 - distance/2 for L2-normalized vectors under L2 distance; raw distance also exposed. */
  score: number;
};

export type VectorStore = {
  readonly backend: "sqlite-vec" | "memory";
  readonly dimensions: number;
  upsert(rowid: number, embedding: number[]): void;
  delete(rowid: number): void;
  search(embedding: number[], k: number): VectorHit[];
  clear(): void;
  size(): number;
};

function assertDims(embedding: number[], dimensions: number): void {
  if (embedding.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: got ${embedding.length}, expected ${dimensions}`);
  }
}

function l2Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** In-memory brute-force vector index (fallback when sqlite-vec fails to load). */
export class MemoryVectorStore implements VectorStore {
  readonly backend = "memory" as const;
  readonly dimensions: number;
  private vectors = new Map<number, Float32Array>();

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  upsert(rowid: number, embedding: number[]): void {
    assertDims(embedding, this.dimensions);
    this.vectors.set(rowid, Float32Array.from(embedding));
  }

  delete(rowid: number): void {
    this.vectors.delete(rowid);
  }

  search(embedding: number[], k: number): VectorHit[] {
    assertDims(embedding, this.dimensions);
    const hits: VectorHit[] = [];
    for (const [rowid, vector] of this.vectors) {
      const distance = l2Distance(embedding, Array.from(vector));
      hits.push({ rowid, distance, score: 1 / (1 + distance) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, k);
  }

  clear(): void {
    this.vectors.clear();
  }

  size(): number {
    return this.vectors.size;
  }
}

export class SqliteVecStore implements VectorStore {
  readonly backend = "sqlite-vec" as const;
  readonly dimensions: number;
  private readonly db: VectorDb;

  constructor(db: VectorDb, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
  }

  upsert(rowid: number, embedding: number[]): void {
    assertDims(embedding, this.dimensions);
    this.db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(BigInt(rowid));
    this.db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)").run(BigInt(rowid), new Float32Array(embedding));
  }

  delete(rowid: number): void {
    this.db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(BigInt(rowid));
  }

  search(embedding: number[], k: number): VectorHit[] {
    assertDims(embedding, this.dimensions);
    const rows = this.db
      .prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .all(new Float32Array(embedding), k) as { rowid: number | bigint; distance: number }[];
    return rows.map((row) => ({
      rowid: Number(row.rowid),
      distance: row.distance,
      score: 1 / (1 + row.distance)
    }));
  }

  clear(): void {
    this.db.exec("DELETE FROM chunks_vec");
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get() as { n: number };
    return Number(row.n);
  }
}

export type EnsureVectorStoreOptions = {
  dimensions?: number;
  /** Force memory backend (tests). */
  forceMemory?: boolean;
  /** Override extension path. */
  extensionPath?: string;
};

/**
 * Load sqlite-vec and create `chunks_vec` (vec0). On failure, return JS memory store — interface unchanged.
 */
export function ensureVectorStore(db: VectorDb, options: EnsureVectorStoreOptions = {}): VectorStore {
  const dimensions = options.dimensions ?? 768;
  if (options.forceMemory) return new MemoryVectorStore(dimensions);

  try {
    const path = options.extensionPath ?? getLoadablePath();
    db.loadExtension(path);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${dimensions}])`);
    return new SqliteVecStore(db, dimensions);
  } catch {
    return new MemoryVectorStore(dimensions);
  }
}
