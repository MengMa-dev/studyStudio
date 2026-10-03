import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkId, chunkText, type ChunkOptions } from "./chunk";
import type { SqlStatement } from "./fts";
import { segmentText } from "./segment";
import { ensureVectorStore, type EnsureVectorStoreOptions, type VectorStore } from "./vectors";

export type SearchDatabase = {
  loadExtension: (path: string) => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqlStatement;
};

export type IndexableDocument = {
  ownerType: string;
  ownerId: string;
  text: string;
};

export type EmbedFn = (text: string) => Promise<number[]> | number[];

export type ReindexProgress = {
  phase: "clear" | "chunk" | "embed" | "done";
  done: number;
  total: number;
  ownerId?: string;
};

export type SearchIndex = {
  vectorStore: VectorStore;
  /** Insert/replace chunks + FTS (+ vectors when embed provided). */
  indexDocument: (doc: IndexableDocument, embedding?: number[] | number[][]) => Promise<void>;
  deleteOwner: (ownerType: string, ownerId: string) => void;
  reindex: (docs: IndexableDocument[], embed: EmbedFn, onProgress?: (progress: ReindexProgress) => void) => Promise<void>;
};

const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../migrations/002_search.sql");

/** Apply 002_search.sql (chunks / FTS / trigram). Safe to call on a fresh in-memory DB in tests. */
export function applySearchMigration(db: SearchDatabase): void {
  const sql = readFileSync(migrationPath, "utf8");
  db.exec(sql);
}

export type CreateSearchIndexOptions = EnsureVectorStoreOptions & {
  chunk?: ChunkOptions;
};

export function createSearchIndex(db: SearchDatabase, options: CreateSearchIndexOptions = {}): SearchIndex {
  applySearchMigration(db);
  const vectorStore = ensureVectorStore(db, options);
  const chunkOpts = options.chunk;

  const deleteOwner = (ownerType: string, ownerId: string): void => {
    const rows = db.prepare("SELECT rowid, text FROM chunks WHERE owner_type = ? AND owner_id = ?").all(ownerType, ownerId) as {
      rowid: number;
      text: string;
    }[];
    for (const row of rows) {
      const rowid = Number(row.rowid);
      // Contentless FTS5 rejects DELETE; the 'delete' command needs the originally indexed values.
      db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, seg_text) VALUES ('delete', ?, ?)").run(rowid, segmentText(row.text));
      db.prepare("INSERT INTO chunks_trigram(chunks_trigram, rowid, text) VALUES ('delete', ?, ?)").run(rowid, row.text.toLowerCase());
      vectorStore.delete(rowid);
    }
    db.prepare("DELETE FROM chunks WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
  };

  const indexDocument = async (doc: IndexableDocument, embedding?: number[] | number[][]): Promise<void> => {
    deleteOwner(doc.ownerType, doc.ownerId);
    const parts = chunkText(doc.text, chunkOpts);
    const embeddings = embedding ? (Array.isArray(embedding[0]) ? (embedding as number[][]) : parts.map(() => embedding as number[])) : null;

    for (const part of parts) {
      const id = chunkId(doc.ownerType, doc.ownerId, part.seq);
      db.prepare("INSERT INTO chunks (id, owner_type, owner_id, seq, text, tokens) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        doc.ownerType,
        doc.ownerId,
        part.seq,
        part.text,
        part.tokens
      );
      const row = db.prepare("SELECT rowid FROM chunks WHERE id = ?").get(id) as { rowid: number };
      const rowid = Number(row.rowid);
      const seg = segmentText(part.text);
      db.prepare("INSERT INTO chunks_fts(rowid, seg_text) VALUES (?, ?)").run(rowid, seg);
      db.prepare("INSERT INTO chunks_trigram(rowid, text) VALUES (?, ?)").run(rowid, part.text.toLowerCase());
      if (embeddings?.[part.seq]) {
        vectorStore.upsert(rowid, embeddings[part.seq]!);
      }
    }
  };

  const reindex = async (docs: IndexableDocument[], embed: EmbedFn, onProgress?: (progress: ReindexProgress) => void): Promise<void> => {
    onProgress?.({ phase: "clear", done: 0, total: docs.length });
    db.exec("DELETE FROM chunks");
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('delete-all')");
    db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES ('delete-all')");
    vectorStore.clear();

    let done = 0;
    for (const doc of docs) {
      onProgress?.({ phase: "chunk", done, total: docs.length, ownerId: doc.ownerId });
      const parts = chunkText(doc.text, chunkOpts);
      const vectors: number[][] = [];
      for (const part of parts) {
        onProgress?.({ phase: "embed", done, total: docs.length, ownerId: doc.ownerId });
        vectors.push(await embed(part.text));
      }
      await indexDocument(doc, vectors);
      done += 1;
      onProgress?.({ phase: "chunk", done, total: docs.length, ownerId: doc.ownerId });
    }
    onProgress?.({ phase: "done", done: docs.length, total: docs.length });
  };

  return { vectorStore, indexDocument, deleteOwner, reindex };
}
