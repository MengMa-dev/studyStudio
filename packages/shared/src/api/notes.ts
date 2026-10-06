import { z } from "zod";

import { noteSummarySchema } from "./inbox";

export const noteScopeSchema = z.enum(["fuzzy", "item", "entry"]);
export type NoteScope = z.infer<typeof noteScopeSchema>;

export const noteOriginSchema = z.enum(["extension", "workbench", "organize_requirement", "derived"]);
export type NoteOrigin = z.infer<typeof noteOriginSchema>;

export const noteSchema = noteSummarySchema.extend({
  derivedFrom: z.string().nullable().optional()
});
export type Note = z.infer<typeof noteSchema>;

export const notesListQuerySchema = z.object({
  scope: noteScopeSchema.optional(),
  targetId: z.string().optional()
});
export type NotesListQuery = z.infer<typeof notesListQuerySchema>;

export const notesListResponseSchema = z.object({
  notes: z.array(noteSchema)
});
export type NotesListResponse = z.infer<typeof notesListResponseSchema>;

export const createNoteRequestSchema = z.object({
  scope: noteScopeSchema,
  targetId: z.string().min(1).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  origin: noteOriginSchema.default("workbench"),
  /** Entry notes only: section id (`<!-- section:… -->`) to pin the note to. */
  anchor: z.string().min(1).max(64).nullable().optional()
});
export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

export const patchNoteRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000)
});
export type PatchNoteRequest = z.infer<typeof patchNoteRequestSchema>;

export const NOTES_API = {
  list: "/v1/notes",
  create: "/v1/notes",
  patch: (id: string) => `/v1/notes/${encodeURIComponent(id)}`,
  delete: (id: string) => `/v1/notes/${encodeURIComponent(id)}`
} as const;
