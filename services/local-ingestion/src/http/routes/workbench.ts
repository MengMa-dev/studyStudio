import type { Hono } from "hono";
import type { AppServices } from "../app.js";
import { notImplemented } from "./not-implemented.js";

/** Inbox, notes, timeline/overview, home and trash (INBOX_API, NOTES_API, TIMELINE_API, HOME_API, TRASH_API). `/presence` stays in app.ts. */
export function registerWorkbenchRoutes(api: Hono, _services: AppServices): void {
  api.get("/workbench/home", notImplemented);

  api.get("/workbench/items", notImplemented);
  // Static segments must be registered before `/workbench/items/:id`.
  api.get("/workbench/items/impact", notImplemented);
  api.post("/workbench/items/bulk", notImplemented);
  api.get("/workbench/items/:id", notImplemented);
  api.patch("/workbench/items/:id", notImplemented);
  api.delete("/workbench/items", notImplemented);

  api.get("/notes", notImplemented);
  api.post("/notes", notImplemented);
  api.patch("/notes/:id", notImplemented);
  api.delete("/notes/:id", notImplemented);

  api.get("/workbench/timeline", notImplemented);
  api.get("/workbench/overview", notImplemented);

  api.get("/workbench/trash", notImplemented);
  api.post("/workbench/trash/:id/restore", notImplemented);
  api.delete("/workbench/trash/:id", notImplemented);
}
