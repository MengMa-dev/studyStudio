import { chunkText, type ChunkOptions } from "./chunk";
import type { IndexableDocument, SearchDatabase, SearchIndex } from "./index-api";

export const ENTRY_OWNER_TYPE = "entry";

export type ChunkIndexerOptions = {
  db: SearchDatabase;
  index: SearchIndex;
  /** Usually `aiGateway.embed`; any failure falls back to FTS-only indexing for that document. */
  embed?: (text: string) => Promise<number[]>;
  chunk?: ChunkOptions;
  onError?: (error: unknown, doc: IndexableDocument) => void;
};

/** Async `chunks` / FTS / vector maintenance (M4). Writers enqueue and return immediately. */
export type ChunkIndexer = {
  /** Replace an owner's chunks in the background; a newer enqueue for the same owner wins. */
  enqueue(doc: IndexableDocument): void;
  /** Drop pending work and existing chunks for an owner (synchronous). */
  remove(ownerType: string, ownerId: string): void;
  /** Enqueue live KB entries that have no chunks yet; returns how many were queued. */
  backfill(): number;
  /** Resolves once the queue is drained. */
  idle(): Promise<void>;
  /** Stop accepting work and wait for the in-flight document. */
  stop(): Promise<void>;
  readonly pending: number;
};

type EntryRow = { id: string; name: string | null; summary: string | null; body_markdown: string | null };

export function entryDocument(row: EntryRow): IndexableDocument {
  const text = [row.name, row.summary, row.body_markdown]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
  return { ownerType: ENTRY_OWNER_TYPE, ownerId: row.id, text };
}

export function createChunkIndexer(options: ChunkIndexerOptions): ChunkIndexer {
  const { db, index } = options;
  const queue = new Map<string, IndexableDocument>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const keyOf = (ownerType: string, ownerId: string) => `${ownerType}\0${ownerId}`;

  const embedParts = async (doc: IndexableDocument): Promise<number[][] | undefined> => {
    if (!options.embed) return undefined;
    try {
      const vectors: number[][] = [];
      for (const part of chunkText(doc.text, options.chunk)) {
        const vector = await options.embed(part.text);
        if (vector.length !== index.vectorStore.dimensions) return undefined;
        vectors.push(vector);
      }
      return vectors.length ? vectors : undefined;
    } catch (error) {
      options.onError?.(error, doc);
      return undefined;
    }
  };

  const processOne = async (doc: IndexableDocument): Promise<void> => {
    const vectors = await embedParts(doc);
    if (stopped) return;
    if (!doc.text.trim()) {
      index.deleteOwner(doc.ownerType, doc.ownerId);
      return;
    }
    try {
      await index.indexDocument(doc, vectors);
    } catch (error) {
      options.onError?.(error, doc);
    }
  };

  const drain = async (): Promise<void> => {
    while (!stopped && queue.size > 0) {
      const [key, doc] = queue.entries().next().value as [string, IndexableDocument];
      queue.delete(key);
      await processOne(doc);
    }
  };

  const kick = (): void => {
    if (running || stopped) return;
    running = new Promise<void>((resolve) => setImmediate(resolve)).then(drain).finally(() => {
      running = null;
      if (!stopped && queue.size > 0) kick();
    });
  };

  return {
    enqueue(doc) {
      if (stopped) return;
      const key = keyOf(doc.ownerType, doc.ownerId);
      queue.delete(key);
      queue.set(key, doc);
      kick();
    },
    remove(ownerType, ownerId) {
      queue.delete(keyOf(ownerType, ownerId));
      index.deleteOwner(ownerType, ownerId);
    },
    backfill() {
      const rows = db
        .prepare(
          `SELECT e.id, e.name, e.summary, e.body_markdown FROM kb_entries e
           WHERE e.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.owner_type = ? AND c.owner_id = e.id)`
        )
        .all(ENTRY_OWNER_TYPE) as EntryRow[];
      let queued = 0;
      for (const row of rows) {
        const doc = entryDocument(row);
        if (!doc.text) continue;
        this.enqueue(doc);
        queued += 1;
      }
      return queued;
    },
    async idle() {
      while (running) await running;
    },
    async stop() {
      stopped = true;
      queue.clear();
      while (running) await running;
    },
    get pending() {
      return queue.size;
    }
  };
}
