import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { validateEvent } from "@study-studio/collector-contract";
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  collectorEventSchema,
  collectorSettingsUpdateSchema,
  exclusionRuleInputSchema,
  eventBatchRequestSchema,
  type CollectorEvent
} from "@study-studio/shared";
import type { AiGateway } from "../ai/gateway.js";
import type { SqliteAiConfigStore } from "../ai/sqlite-stores.js";
import type { AppDatabase } from "../db/database.js";
import type { ChunkIndexer } from "../search/background.js";
import type { SearchIndex } from "../search/index-api.js";
import { ingest, pageCaptured, type IngestContext } from "../domains/capture/ingest.js";
import { PresenceStore } from "../domains/capture/presence.js";
import { deleteRule, insertRule, listRules } from "../domains/capture/rules.js";
import { buildCollectorSettings, ensureDefaultSettings, settingsEtag, updateCollectorSettings } from "../domains/settings/settings.js";
import {
  createAuthState,
  consumeLoginCode,
  createSession,
  hostGuard,
  issueLoginCode,
  requireCaptureOrWorkbench,
  requireSameOrigin,
  setSessionCookie,
  type AuthState
} from "./auth.js";
import { createKbRegistryTrashHandler, KB_TRASH_KIND } from "../domains/kb/trash.js";
import { registerTrashHandler } from "../domains/trash/registry.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerKbRoutes } from "./routes/kb.js";
import { registerOrganizeRoutes } from "./routes/organize.js";
import { registerWorkbenchRoutes } from "./routes/workbench.js";

const MAX_EVENT_BYTES = 20 * 1024 * 1024;

export type AppServices = {
  appDb: AppDatabase;
  auth: AuthState;
  presence: PresenceStore;
  ingestCtx: IngestContext;
  getPort: () => number;
  workbenchDist: string;
  /** Where /app/login lands; `npm run dev` points it at the Vite server so the stale dist is never shown. */
  workbenchUrl?: string;
  aiGateway?: AiGateway;
  searchIndex?: SearchIndex;
  /** Shared with `aiGateway`; AI routes fall back to a store over `appDb` + `<dataDir>/secrets.json`. */
  aiConfig?: SqliteAiConfigStore;
  /** Background chunks / FTS / vector upkeep; enqueue after entry writes. */
  chunkIndexer?: ChunkIndexer;
};

export function createApp(services: AppServices): Hono {
  const { appDb, auth, presence, ingestCtx, getPort, workbenchDist } = services;
  ensureDefaultSettings(appDb.db);

  const app = new Hono();
  app.use("*", hostGuard(getPort));

  app.get("/health", (c) => c.json({ ok: true, vectorEnabled: appDb.vectorEnabled }));

  // One-time workbench login: /app/login?code= → HttpOnly cookie, then redirect.
  app.get("/app/login", (c) => {
    const code = c.req.query("code");
    if (!code || !consumeLoginCode(auth, code)) {
      return c.html("<!doctype html><title>Study Studio</title><p>登录链接无效或已过期，请从终端重新打开。</p>", 401);
    }
    const session = createSession(auth);
    setSessionCookie(c, session);
    return c.redirect(services.workbenchUrl ?? "/app/");
  });

  if (existsSync(workbenchDist)) {
    app.use(
      "/app/*",
      serveStatic({
        root: workbenchDist,
        rewriteRequestPath: (path) => path.replace(/^\/app/, "") || "/index.html"
      })
    );
    // Client-side routes (no file extension) fall back to the SPA shell.
    app.get("/app/*", (c, next) => {
      if (/\.[a-z0-9]+$/i.test(c.req.path)) return next();
      return c.html(readFileSync(join(workbenchDist, "index.html"), "utf8"));
    });
  } else {
    app.get("/app", (c) => c.redirect("/app/"));
    app.get("/app/", (c) =>
      c.html(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Study Studio</title></head>
<body style="font-family:system-ui;padding:2rem;max-width:40rem">
<h1>Study Studio</h1>
<p>工作台前端尚未构建。请先构建 <code>apps/workbench</code>，或使用 API / 扩展进行采集。</p>
<p>本地服务运行正常。</p>
</body></html>`
      )
    );
  }

  const api = new Hono();
  api.use("*", requireCaptureOrWorkbench(auth));
  api.use("*", requireSameOrigin(getPort));

  api.get("/pairing", (c) => c.json({ paired: true }));

  api.get("/pages", (c) => {
    const canonicalUrl = c.req.query("canonicalUrl");
    if (!canonicalUrl || !/^https?:\/\//.test(canonicalUrl)) {
      return c.json({ error: "canonicalUrl is invalid" }, 422);
    }
    return c.json({ captured: pageCaptured(appDb.db, canonicalUrl) });
  });

  api.post("/events", async (c) => {
    let event: unknown;
    try {
      const raw = await c.req.arrayBuffer();
      if (raw.byteLength > MAX_EVENT_BYTES) return c.json({ error: "payload_too_large" }, 413);
      event = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const validationError = validateEvent(event);
    if (validationError) return c.json({ error: validationError }, 422);
    const parsed = collectorEventSchema.parse(event);
    const result = ingest(ingestCtx, parsed);
    return c.json(result.body, result.httpStatus as 200 | 201 | 202);
  });

  api.post("/events/batch", async (c) => {
    let raw: ArrayBuffer;
    try {
      raw = await c.req.arrayBuffer();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (raw.byteLength > MAX_BATCH_BYTES) return c.json({ error: "payload_too_large" }, 413);

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const parsed = eventBatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_batch" }, 422);
    }
    if (parsed.data.events.length > MAX_BATCH_EVENTS) {
      return c.json({ error: `batch exceeds ${MAX_BATCH_EVENTS} events` }, 422);
    }

    const results: { id: string | null; status: "accepted" | "duplicate" | "ignored" | "rejected"; error?: string }[] = [];
    for (const event of parsed.data.events) {
      const validationError = validateEvent(event);
      if (validationError) {
        const id =
          event && typeof event === "object" && "id" in event && typeof (event as { id: unknown }).id === "string" ? (event as { id: string }).id : null;
        results.push({ id, status: "rejected", error: validationError });
        continue;
      }
      const ok = collectorEventSchema.parse(event) as CollectorEvent;
      const result = ingest(ingestCtx, ok);
      results.push({
        id: ok.id,
        status: result.status === "duplicate" ? "duplicate" : result.status,
        ...(result.status === "rejected" ? { error: result.error } : {})
      });
    }
    return c.json({ results });
  });

  api.get("/settings", (c) => {
    const settings = buildCollectorSettings(appDb.db);
    const etag = settingsEtag(settings);
    const inm = c.req.header("if-none-match");
    if (inm && inm === etag) return c.body(null, 304);
    c.header("ETag", etag);
    return c.json(settings);
  });

  api.put("/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = collectorSettingsUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_settings" }, 422);
    const settings = updateCollectorSettings(appDb.db, parsed.data);
    const etag = settingsEtag(settings);
    c.header("ETag", etag);
    return c.json(settings);
  });

  api.get("/rules", (c) => c.json({ rules: listRules(appDb.db) }));

  api.post("/rules", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = exclusionRuleInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid_rule" }, 422);
    const rule = {
      id: randomUUID(),
      kind: parsed.data.kind,
      value: parsed.data.value,
      note: parsed.data.note ?? null,
      createdAt: new Date().toISOString()
    };
    insertRule(appDb.db, rule);
    return c.json({ rule }, 201);
  });

  api.delete("/rules/:id", (c) => {
    const id = c.req.param("id");
    if (!deleteRule(appDb.db, id)) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted: true });
  });

  api.post("/presence", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const data = body as { title?: string; url?: string; visibleSeconds?: number; captured?: boolean; key?: string };
    if (!data.url || typeof data.url !== "string") return c.json({ error: "url is required" }, 422);
    const entry = presence.upsert(data.key ?? data.url, {
      title: data.title ?? "",
      url: data.url,
      visibleSeconds: Number(data.visibleSeconds ?? 0),
      captured: Boolean(data.captured)
    });
    return c.json({ ok: true, entry });
  });

  api.get("/presence", (c) => c.json({ entries: presence.list() }));

  registerTrashHandler(KB_TRASH_KIND, createKbRegistryTrashHandler({ searchIndex: services.searchIndex }));
  registerWorkbenchRoutes(api, services);
  registerDataRoutes(api, services);
  registerAiRoutes(api, services);
  registerOrganizeRoutes(api, services);
  registerKbRoutes(api, services);

  app.route("/v1", api);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}

export function createLoginLink(auth: AuthState, port: number): string {
  const code = issueLoginCode(auth);
  return `http://127.0.0.1:${port}/app/login?code=${code}`;
}

export function workbenchDistPath(root = process.cwd()): string {
  return join(root, "apps/workbench/dist");
}

export { createAuthState };
