import type { Hono } from "hono";
import type { AppServices } from "../app.js";
import { notImplemented } from "./not-implemented.js";

/** DATA_API. `/settings` and `/rules` stay in app.ts. */
export function registerDataRoutes(api: Hono, _services: AppServices): void {
  api.get("/data/info", notImplemented);
  api.post("/data/export", notImplemented);
  api.post("/data/import", notImplemented);
  api.post("/data/reindex", notImplemented);
  api.post("/data/reveal", notImplemented);
  api.post("/data/wipe", notImplemented);
  api.post("/pairing/reset", notImplemented);
  api.get("/settings/learner-profile", notImplemented);
  api.put("/settings/learner-profile", notImplemented);
  api.get("/workbench/onboarding", notImplemented);
  api.post("/workbench/onboarding", notImplemented);
}
