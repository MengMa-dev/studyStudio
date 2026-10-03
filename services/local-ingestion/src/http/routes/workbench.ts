import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  createNoteRequestSchema,
  deleteItemsRequestSchema,
  inboxBulkActionSchema,
  inboxItemPatchSchema,
  inboxListQuerySchema,
  notesListQuerySchema,
  overviewQuerySchema,
  patchNoteRequestSchema,
  timelineQuerySchema
} from "@study-studio/shared";
import type { AppServices } from "../app.js";
import { getHomeSummary } from "../../domains/home/home.js";
import { deleteImpact, deleteItems, NothingToDeleteError } from "../../domains/inbox/delete.js";
import { bulkUpdateItems, getItemDetail, patchItem } from "../../domains/inbox/detail.js";
import { decodeCursor, listInbox } from "../../domains/inbox/list.js";
import { createNote, deleteNote, listNotes, NoteTargetError, patchNote } from "../../domains/notes/notes.js";
import { getOverview, getTimeline } from "../../domains/timeline/timeline.js";
import { TrashConflictError } from "../../domains/trash/registry.js";
import { purgeTrash, restoreTrash, TrashKindNotSupportedError, TrashNotFoundError } from "../../domains/trash/service.js";
import { listTrash } from "../../domains/trash/store.js";

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export async function parseJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, response: c.json({ error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, response: c.json({ error: parsed.error.issues[0]?.message ?? "invalid_body" }, 422) };
  return { ok: true, data: parsed.data };
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): Parsed<z.infer<S>> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) return { ok: false, response: c.json({ error: parsed.error.issues[0]?.message ?? "invalid_query" }, 422) };
  return { ok: true, data: parsed.data };
}

function splitIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];
}

/** Inbox, notes, timeline/overview, home and trash (INBOX_API, NOTES_API, TIMELINE_API, HOME_API, TRASH_API). `/presence` stays in app.ts. */
export function registerWorkbenchRoutes(api: Hono, services: AppServices): void {
  const db = services.appDb.db;
  const trashCtx = { db, dataDir: services.appDb.dataDir };

  api.get("/workbench/home", (c) => c.json(getHomeSummary(db)));

  api.get("/workbench/items", (c) => {
    const query = parseQuery(c, inboxListQuerySchema);
    if (!query.ok) return query.response;
    if (query.data.cursor && !decodeCursor(query.data.cursor)) return c.json({ error: "invalid_cursor" }, 422);
    return c.json(listInbox(db, query.data));
  });

  // Static segments must be registered before `/workbench/items/:id`.
  api.get("/workbench/items/impact", (c) => {
    const ids = splitIds(c.req.query("ids"));
    const noteIds = splitIds(c.req.query("noteIds"));
    if (!ids.length && !noteIds.length) return c.json({ error: "ids is required" }, 422);
    return c.json(deleteImpact(db, ids, noteIds));
  });

  api.post("/workbench/items/bulk", async (c) => {
    const body = await parseJsonBody(c, inboxBulkActionSchema);
    if (!body.ok) return body.response;
    return c.json({ updated: bulkUpdateItems(db, body.data) });
  });

  // Opening the detail marks the item read, matching the workbench mock (pass `?markRead=0` to skip).
  api.get("/workbench/items/:id", (c) => {
    const id = c.req.param("id");
    const detail = getItemDetail(db, id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    if (detail.readStatus === "unread" && c.req.query("markRead") !== "0") {
      return c.json(patchItem(db, id, { readStatus: "read" })!);
    }
    return c.json(detail);
  });

  api.patch("/workbench/items/:id", async (c) => {
    const body = await parseJsonBody(c, inboxItemPatchSchema);
    if (!body.ok) return body.response;
    const detail = patchItem(db, c.req.param("id"), body.data);
    if (!detail) return c.json({ error: "not_found" }, 404);
    return c.json(detail);
  });

  api.delete("/workbench/items", async (c) => {
    const body = await parseJsonBody(c, deleteItemsRequestSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(deleteItems(db, body.data));
    } catch (error) {
      if (error instanceof NothingToDeleteError) return c.json({ error: "not_found" }, 404);
      throw error;
    }
  });

  api.get("/notes", (c) => {
    const query = parseQuery(c, notesListQuerySchema);
    if (!query.ok) return query.response;
    return c.json({ notes: listNotes(db, query.data) });
  });

  api.post("/notes", async (c) => {
    const body = await parseJsonBody(c, createNoteRequestSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(createNote(db, body.data), 201);
    } catch (error) {
      if (error instanceof NoteTargetError) return c.json({ error: error.message }, 422);
      throw error;
    }
  });

  api.patch("/notes/:id", async (c) => {
    const body = await parseJsonBody(c, patchNoteRequestSchema);
    if (!body.ok) return body.response;
    const note = patchNote(db, c.req.param("id"), body.data.text);
    if (!note) return c.json({ error: "not_found" }, 404);
    return c.json(note);
  });

  api.delete("/notes/:id", (c) => {
    if (!deleteNote(db, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true as const });
  });

  api.get("/workbench/timeline", (c) => {
    const query = parseQuery(c, timelineQuerySchema);
    if (!query.ok) return query.response;
    return c.json(getTimeline(db, query.data));
  });

  api.get("/workbench/overview", (c) => {
    const query = parseQuery(c, overviewQuerySchema);
    if (!query.ok) return query.response;
    return c.json(getOverview(db, query.data));
  });

  api.get("/workbench/trash", (c) => c.json({ entries: listTrash(db) }));

  const trashError = (c: Context, error: unknown) => {
    if (error instanceof TrashNotFoundError) return c.json({ error: "not_found" }, 404);
    if (error instanceof TrashKindNotSupportedError) return c.json({ error: "not_implemented", message: error.message }, 501);
    if (error instanceof TrashConflictError) return c.json({ error: "conflict", message: error.message }, 409);
    throw error;
  };

  api.post("/workbench/trash/:id/restore", async (c) => {
    try {
      return c.json(await restoreTrash(trashCtx, c.req.param("id")));
    } catch (error) {
      return trashError(c, error);
    }
  });

  api.delete("/workbench/trash/:id", async (c) => {
    try {
      await purgeTrash(trashCtx, c.req.param("id"));
      return c.json({ ok: true as const });
    } catch (error) {
      return trashError(c, error);
    }
  });
}
