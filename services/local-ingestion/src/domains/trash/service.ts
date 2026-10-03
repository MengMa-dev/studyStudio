import type { TrashRestoreResponse } from "@study-studio/shared";
import { ITEM_TRASH_KINDS, itemTrashHandler } from "./items.js";
import { getTrashHandler, type TrashHandler, type TrashHandlerContext, type TrashRecord } from "./registry.js";
import { getTrashRecord } from "./store.js";

export class TrashNotFoundError extends Error {
  constructor(id: string) {
    super(`trash not found: ${id}`);
    this.name = "TrashNotFoundError";
  }
}

export class TrashKindNotSupportedError extends Error {
  constructor(kind: string) {
    super(`no trash handler registered for kind "${kind}"`);
    this.name = "TrashKindNotSupportedError";
  }
}

function handlerFor(record: TrashRecord): TrashHandler {
  const handler = ITEM_TRASH_KINDS.has(record.kind) ? itemTrashHandler : getTrashHandler(record.kind);
  if (!handler) throw new TrashKindNotSupportedError(record.kind);
  return handler;
}

function load(ctx: TrashHandlerContext, id: string): TrashRecord {
  const record = getTrashRecord(ctx.db, id);
  if (!record) throw new TrashNotFoundError(id);
  return record;
}

export async function restoreTrash(ctx: TrashHandlerContext, id: string): Promise<TrashRestoreResponse> {
  const record = load(ctx, id);
  const counts = await handlerFor(record).restore(ctx, record);
  ctx.db.prepare("DELETE FROM trash WHERE id = ?").run(id);
  return {
    restoredItemCount: counts.restoredItemCount ?? 0,
    restoredNoteCount: counts.restoredNoteCount ?? 0,
    restoredEntryCount: counts.restoredEntryCount ?? 0
  };
}

export async function purgeTrash(ctx: TrashHandlerContext, id: string): Promise<void> {
  const record = load(ctx, id);
  await handlerFor(record).purge(ctx, record);
  ctx.db.prepare("DELETE FROM trash WHERE id = ?").run(id);
}
