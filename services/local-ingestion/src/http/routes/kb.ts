import type { Hono } from "hono";
import type { AppServices } from "../app.js";
import { notImplemented } from "./not-implemented.js";

/** KB_API (08). */
export function registerKbRoutes(api: Hono, _services: AppServices): void {
  api.get("/kb/tree", notImplemented);
  // Must precede `/kb/entries/:id`.
  api.get("/kb/entries/impact", notImplemented);
  api.get("/kb/entries/:id", notImplemented);
  api.patch("/kb/entries/:id", notImplemented);
  api.delete("/kb/entries", notImplemented);
}
