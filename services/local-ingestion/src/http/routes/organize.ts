import type { Hono } from "hono";
import type { AppServices } from "../app.js";
import { notImplemented } from "./not-implemented.js";

/** ORGANIZE_API (07 / 10). */
export function registerOrganizeRoutes(api: Hono, _services: AppServices): void {
  api.get("/organize/settings", notImplemented);
  api.put("/organize/settings", notImplemented);
  api.post("/organize/preview", notImplemented);
  api.post("/organize/run", notImplemented);
  api.get("/organize/runs", notImplemented);
  api.get("/organize/runs/:id", notImplemented);
  api.post("/organize/runs/:id/retry", notImplemented);
  api.get("/organize/events", notImplemented);
}
