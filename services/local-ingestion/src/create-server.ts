import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { AiGateway, type AiGatewayOptions } from "./ai/gateway.js";
import { SecretsFile, secretsPathFor } from "./ai/secrets.js";
import { importAiSeedIfEmpty } from "./ai/seed.js";
import { SqliteAiConfigStore, SqliteUsageStore } from "./ai/sqlite-stores.js";
import { openDatabase, type AppDatabase } from "./db/database.js";
import { createChunkIndexer, type ChunkIndexer } from "./search/background.js";
import { createSearchIndex, type IndexableDocument, type SearchIndex } from "./search/index-api.js";
import { PresenceStore } from "./domains/capture/presence.js";
import { ensureDefaultSettings } from "./domains/settings/settings.js";
import { startOrganizeWorker } from "./jobs/organize-worker.js";
import { startScheduler, type Scheduler } from "./jobs/scheduler.js";
import { createApp, createAuthState, createLoginLink, workbenchDistPath } from "./http/app.js";

export { writeLoginCode } from "./http/auth.js";
export { SKILL_DIRS } from "./domains/agent/skill.js";
export { installAgent, mergeCodexMcp, mergeCursorMcp, type McpEndpoint } from "./domains/agent/install.js";

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
  workbenchUrl?: string;
  /** Gateway extras (mock fixtures / rules, retry) — tests and fixture replay. */
  ai?: Omit<AiGatewayOptions, "configStore" | "usageStore">;
  /** `chunks_vec` dimensions; must match the embedding model (default 768, nomic-embed-text). */
  embeddingDimensions?: number;
  /** Skip the startup backfill of KB entries missing chunks (tests). */
  disableBackgroundIndex?: boolean;
  onIndexError?: (error: unknown, doc: IndexableDocument) => void;
};

export type IngestionServer = {
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Exposed for tests. */
  db: AppDatabase;
  auth: ReturnType<typeof createAuthState>;
  scheduler: Scheduler | null;
  aiGateway: AiGateway;
  aiConfig: SqliteAiConfigStore;
  searchIndex: SearchIndex;
  chunkIndexer: ChunkIndexer;
};

function ensurePairingToken(dataDir: string, pairingToken: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, ".pairing-token");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, pairingToken, { mode: 0o600 });
  return pairingToken;
}

function ensureMcpToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, "mcp-token");
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
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

  const aiConfig = new SqliteAiConfigStore(appDb.db, new SecretsFile(secretsPathFor(dataDir)));
  importAiSeedIfEmpty(aiConfig, dataDir);
  const aiGateway = new AiGateway({
    ...options.ai,
    configStore: aiConfig,
    usageStore: new SqliteUsageStore(appDb.db),
    embeddingDimensions: options.ai?.embeddingDimensions ?? options.embeddingDimensions
  });
  const searchIndex = createSearchIndex(appDb.db, {
    dimensions: options.embeddingDimensions,
    forceMemory: !appDb.vectorEnabled
  });
  const chunkIndexer = createChunkIndexer({
    db: appDb.db,
    index: searchIndex,
    embed: async (text) => (await aiGateway.embed({ value: text })).embedding,
    onError: options.onIndexError
  });
  if (!options.disableBackgroundIndex) chunkIndexer.backfill();

  let port = 0;
  const auth = createAuthState(options.pairingToken, port, ensureMcpToken(dataDir), dataDir);
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
    workbenchDist: options.workbenchDist ?? workbenchDistPath(),
    ...(options.workbenchUrl ? { workbenchUrl: options.workbenchUrl } : {}),
    aiGateway,
    aiConfig,
    searchIndex,
    chunkIndexer
  });

  const scheduler = options.disableScheduler ? null : startScheduler(appDb.db, appDb.dataDir);
  const organizeWorker = options.disableScheduler ? null : startOrganizeWorker(appDb);

  let nodeServer: ReturnType<typeof createServer> | null = null;

  return {
    db: appDb,
    auth,
    scheduler,
    aiGateway,
    aiConfig,
    searchIndex,
    chunkIndexer,
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
      await organizeWorker?.stop();
      await new Promise<void>((resolve) => {
        if (!nodeServer) return resolve();
        nodeServer.close(() => resolve());
      });
      await chunkIndexer.stop();
      appDb.close();
    }
  };
}

export type StartOptions = {
  /** Overrides STUDY_STUDIO_DATA_DIR. */
  dataDir?: string;
  /** Overrides STUDY_STUDIO_PORT. */
  port?: number;
  workbenchDist?: string;
};

export type StartedServer = {
  port: number;
  dataDir: string;
  loginUrl: string;
  vectorEnabled: boolean;
};

export async function startFromEnv(options: StartOptions = {}): Promise<StartedServer> {
  const port = options.port ?? Number(process.env.STUDY_STUDIO_PORT ?? 43118);
  const dataDir = options.dataDir ?? process.env.STUDY_STUDIO_DATA_DIR ?? join(process.cwd(), "StudyStudioData");
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, ".pairing-token");
  const pairingToken = process.env.STUDY_STUDIO_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : randomUUID());
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, pairingToken, { mode: 0o600 });

  const dev = process.env.STUDY_STUDIO_DEV === "1";
  const ingestion = await createIngestionServer({
    dataDir,
    pairingToken,
    ...(dev ? { minRevisitSeconds: 3 } : {}),
    onIndexError: (error, doc) => console.warn(`[search] ${doc.ownerType}/${doc.ownerId}: ${error instanceof Error ? error.message : String(error)}`),
    ...(options.workbenchDist ? { workbenchDist: options.workbenchDist } : {}),
    ...(process.env.STUDY_STUDIO_WORKBENCH_URL ? { workbenchUrl: process.env.STUDY_STUDIO_WORKBENCH_URL } : {})
  });

  const listenPort = await ingestion.listen(port);
  const login = createLoginLink(ingestion.auth, listenPort);
  console.log(`Study Studio listening at http://127.0.0.1:${listenPort}${dev ? " (DEV)" : ""}`);
  console.log(`Workbench login: ${login}`);
  console.log(`Pairing token: ${pairingToken}（浏览器扩展在打开工作台时自动配对，一般无需手填）`);
  console.log(`Data directory: ${dataDir}`);
  console.log(`Vector search: ${ingestion.db.vectorEnabled ? "enabled" : "disabled"}`);
  console.log(`AI providers: ${ingestion.aiConfig.countProviders()}`);

  const shutdown = async () => {
    console.log("Shutting down…");
    await ingestion.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return { port: listenPort, dataDir, loginUrl: login, vectorEnabled: ingestion.db.vectorEnabled };
}
