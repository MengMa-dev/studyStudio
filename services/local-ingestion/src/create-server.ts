import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { openDatabase, type AppDatabase } from "./db/database.js";
import { PresenceStore } from "./domains/capture/presence.js";
import { ensureDefaultSettings } from "./domains/settings/settings.js";
import { startScheduler, type Scheduler } from "./jobs/scheduler.js";
import { createApp, createAuthState, createLoginLink, workbenchDistPath } from "./http/app.js";

export type CreateIngestionServerOptions = {
  dataDir: string;
  pairingToken: string;
  /** Override revisit threshold (DEV / tests). */
  minRevisitSeconds?: number;
  /** Use in-memory SQLite (unit tests). When true, dataDir is still used for blobs if needed. */
  memory?: boolean;
  skipVector?: boolean;
  /** Disable cron jobs (tests). */
  disableScheduler?: boolean;
  workbenchDist?: string;
};

export type IngestionServer = {
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Exposed for tests. */
  db: AppDatabase;
  auth: ReturnType<typeof createAuthState>;
  scheduler: Scheduler | null;
};

function ensurePairingToken(dataDir: string, pairingToken: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, ".pairing-token");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, pairingToken, { mode: 0o600 });
  return pairingToken;
}

export async function createIngestionServer(options: CreateIngestionServerOptions): Promise<IngestionServer> {
  if (!options.pairingToken) throw new Error("pairingToken is required");
  const dataDir = options.dataDir;
  ensurePairingToken(dataDir, options.pairingToken);

  const appDb = openDatabase({
    dataDir,
    memory: options.memory,
    skipVector: options.skipVector
  });

  ensureDefaultSettings(appDb.db);

  let port = 0;
  const auth = createAuthState(options.pairingToken, port);
  const presence = new PresenceStore();
  const ingestCtx = {
    app: appDb,
    minRevisitSeconds: options.minRevisitSeconds
  };

  const hono = createApp({
    appDb,
    auth,
    presence,
    ingestCtx,
    getPort: () => port,
    workbenchDist: options.workbenchDist ?? workbenchDistPath()
  });

  const scheduler = options.disableScheduler ? null : startScheduler(appDb.db, appDb.dataDir);

  let nodeServer: ReturnType<typeof createServer> | null = null;

  return {
    db: appDb,
    auth,
    scheduler,
    listen(listenPort = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        try {
          nodeServer = serve(
            {
              fetch: hono.fetch,
              hostname: host,
              port: listenPort,
              createServer
            },
            (info) => {
              port = info.port;
              auth.port = info.port;
              resolve(info.port);
            }
          ) as unknown as ReturnType<typeof createServer>;
        } catch (error) {
          reject(error);
        }
      });
    },
    async close() {
      scheduler?.stop();
      await new Promise<void>((resolve) => {
        if (!nodeServer) return resolve();
        nodeServer.close(() => resolve());
      });
      appDb.close();
    }
  };
}

export async function startFromEnv(): Promise<void> {
  const port = Number(process.env.STUDY_STUDIO_PORT ?? 43118);
  const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(process.cwd(), "StudyStudioData");
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, ".pairing-token");
  const pairingToken = process.env.STUDY_STUDIO_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : randomUUID());
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, pairingToken, { mode: 0o600 });

  const dev = process.env.STUDY_STUDIO_DEV === "1";
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken,
    ...(dev ? { minRevisitSeconds: 3 } : {})
  });

  await ingestion.listen(port);
  const login = createLoginLink(ingestion.auth, port);
  console.log(`Study Studio listening at http://127.0.0.1:${port}${dev ? " (DEV)" : ""}`);
  console.log(`Workbench login: ${login}`);
  console.log(`Pairing token: ${pairingToken}`);
  console.log(`Data directory: ${dataDir}`);
  console.log(`Vector search: ${ingestion.db.vectorEnabled ? "enabled" : "disabled"}`);

  const shutdown = async () => {
    console.log("Shutting down…");
    await ingestion.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
