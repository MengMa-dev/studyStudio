import { z } from "zod";

import { inboxItemTypeSchema } from "./inbox";

export const trashEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["items", "notes", "mixed"]),
  title: z.string(),
  site: z.string().nullable(),
  itemType: inboxItemTypeSchema.nullable(),
  deletedAt: z.string(),
  expiresAt: z.string(),
  removeFromKb: z.boolean(),
  removedEntryCount: z.number().int().nonnegative(),
  itemIds: z.array(z.string()),
  noteIds: z.array(z.string())
});
export type TrashEntry = z.infer<typeof trashEntrySchema>;

export const trashListResponseSchema = z.object({
  entries: z.array(trashEntrySchema)
});
export type TrashListResponse = z.infer<typeof trashListResponseSchema>;

export const trashRestoreResponseSchema = z.object({
  restoredItemCount: z.number().int().nonnegative(),
  restoredNoteCount: z.number().int().nonnegative()
});
export type TrashRestoreResponse = z.infer<typeof trashRestoreResponseSchema>;

export const trashPurgeResponseSchema = z.object({
  ok: z.literal(true)
});
export type TrashPurgeResponse = z.infer<typeof trashPurgeResponseSchema>;

export const TRASH_API = {
  list: "/v1/workbench/trash",
  restore: (id: string) => `/v1/workbench/trash/${encodeURIComponent(id)}/restore`,
  purge: (id: string) => `/v1/workbench/trash/${encodeURIComponent(id)}`
} as const;
