import type { DatabaseSync } from "node:sqlite";

export type TrashTargets = {
  itemIds: string[];
  noteIds: string[];
  entryIds: string[];
};

/** Display fields stored under `trash.snapshot.meta`, used by the trash list for every kind. */
export type TrashMeta = {
  title: string;
  site: string | null;
  itemType: "webpage" | "conversation" | "document" | null;
  removeFromKb: boolean;
  removedEntryCount: number;
};

/** A `trash` row with JSON columns parsed. `payload` is owned by whoever wrote the row. */
export type TrashRecord = {
  id: string;
  kind: string;
  targets: TrashTargets;
  meta: TrashMeta;
  payload: unknown;
  deletedAt: string;
  expiresAt: string;
};

export type TrashHandlerContext = {
  db: DatabaseSync;
  dataDir: string | null;
};

export type TrashRestoreCounts = {
  restoredItemCount?: number;
  restoredNoteCount?: number;
  restoredEntryCount?: number;
};

/**
 * Restores or physically removes the entities behind one trash row. The handler owns its own transaction;
 * the caller deletes the `trash` row only after the handler resolves. Throw `TrashConflictError` to answer 409.
 */
export type TrashHandler = {
  restore(ctx: TrashHandlerContext, record: TrashRecord): TrashRestoreCounts | Promise<TrashRestoreCounts>;
  purge(ctx: TrashHandlerContext, record: TrashRecord): void | Promise<void>;
};

export class TrashConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrashConflictError";
  }
}

const handlers = new Map<string, TrashHandler>();

/** Registers the handler for a trash `kind` (e.g. `entries` from the knowledge base). Returns an unregister function. */
export function registerTrashHandler(kind: string, handler: TrashHandler): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

export function getTrashHandler(kind: string): TrashHandler | undefined {
  return handlers.get(kind);
}
