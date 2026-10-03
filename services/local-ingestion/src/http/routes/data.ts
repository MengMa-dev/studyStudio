import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { dataWipeRequestSchema, learnerProfileUpdateSchema } from "@study-studio/shared";
import type { AppServices } from "../app.js";
import { DataDirRequiredError, exportBackup, exportsDir, importBackup, InvalidBackupError, wipeData } from "../../domains/data/backup.js";
import { extensionStatus, getDataInfo, resetPairingToken } from "../../domains/data/info.js";
import { completeOnboarding, onboardingCompleted, readLearnerProfile, saveLearnerProfile } from "../../domains/data/profile.js";
import { startReindex } from "../../domains/data/reindex.js";
import { revealPath } from "../../domains/data/reveal.js";
import { parseJsonBody } from "./workbench.js";

const importByNameSchema = z.object({ filename: z.string().min(1) });

/** DATA_API. `/settings` and `/rules` stay in app.ts. */
export function registerDataRoutes(api: Hono, services: AppServices): void {
  const { appDb, auth, presence } = services;
  const db = appDb.db;

  const onboardingStatus = () => ({
    needsOnboarding: !onboardingCompleted(db),
    pairingToken: auth.pairingToken,
    extensionConnected: extensionStatus(appDb, presence).connected
  });

  api.get("/data/info", (c) => c.json(getDataInfo({ appDb, auth, presence, port: services.getPort() })));

  api.post("/data/export", (c) => {
    try {
      const { filename, sizeBytes } = exportBackup(appDb);
      return c.json({ filename, sizeBytes });
    } catch (error) {
      if (error instanceof DataDirRequiredError) return c.json({ error: "no_data_dir" }, 409);
      throw error;
    }
  });

  // Body: the backup zip itself (application/zip | application/octet-stream), or JSON `{ filename }` of a file in exports/.
  api.post("/data/import", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let archive: Buffer;
    if (contentType.includes("application/json")) {
      const body = await parseJsonBody(c, importByNameSchema);
      if (!body.ok) return body.response;
      if (!appDb.dataDir) return c.json({ error: "no_data_dir" }, 409);
      const path = join(exportsDir(appDb.dataDir), basename(body.data.filename));
      if (!existsSync(path)) return c.json({ error: "backup_not_found" }, 404);
      archive = readFileSync(path);
    } else {
      archive = Buffer.from(await c.req.arrayBuffer());
      if (!archive.length) return c.json({ error: "backup file is required" }, 400);
    }
    try {
      const { itemCount } = importBackup(appDb, archive);
      if (services.searchIndex) startReindex(db, services.searchIndex, services.aiGateway);
      return c.json({ ok: true as const, itemCount });
    } catch (error) {
      if (error instanceof InvalidBackupError) return c.json({ error: "invalid_backup", message: error.message }, 422);
      throw error;
    }
  });

  api.post("/data/reindex", (c) => {
    const job = startReindex(db, services.searchIndex, services.aiGateway);
    return c.json({ jobId: job.id, status: job.status }, job.status === "done" ? 200 : 202);
  });

  api.post("/data/reveal", (c) => {
    if (!appDb.dataDir) return c.json({ error: "no_data_dir" }, 409);
    revealPath(appDb.dataDir);
    return c.json({ ok: true as const });
  });

  api.post("/data/wipe", async (c) => {
    const body = await parseJsonBody(c, dataWipeRequestSchema);
    if (!body.ok) return body.response;
    const { backupFilename } = wipeData(appDb);
    presence.clear();
    if (services.searchIndex) await services.searchIndex.reindex([], () => []);
    return c.json({ ok: true as const, backupFilename });
  });

  api.post("/pairing/reset", (c) => c.json(resetPairingToken(appDb, auth)));

  api.get("/settings/learner-profile", (c) => c.json({ profile: readLearnerProfile(db) }));

  api.put("/settings/learner-profile", async (c) => {
    const body = await parseJsonBody(c, learnerProfileUpdateSchema);
    if (!body.ok) return body.response;
    return c.json({ profile: saveLearnerProfile(db, body.data) });
  });

  api.get("/workbench/onboarding", (c) => c.json(onboardingStatus()));

  api.post("/workbench/onboarding", (c) => {
    completeOnboarding(db);
    return c.json(onboardingStatus());
  });
}
