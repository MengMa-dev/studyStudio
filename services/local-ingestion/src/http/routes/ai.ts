import type { Hono } from "hono";
import type { AppServices } from "../app.js";
import { notImplemented } from "./not-implemented.js";

/** AI_API (06). */
export function registerAiRoutes(api: Hono, _services: AppServices): void {
  api.get("/ai/providers", notImplemented);
  api.post("/ai/providers", notImplemented);
  api.patch("/ai/providers/:id", notImplemented);
  api.delete("/ai/providers/:id", notImplemented);
  api.post("/ai/providers/:id/test", notImplemented);
  api.get("/ai/tasks", notImplemented);
  api.put("/ai/tasks", notImplemented);
  api.get("/ai/usage", notImplemented);
  api.put("/ai/limits", notImplemented);
}
