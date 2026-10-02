/**
 * Minimal local-ingestion stub for extension e2e (01 + packages/shared schemas).
 * Swap to services/local-ingestion after the real server lands.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_ACTIVITY_TRACKING,
  DEFAULT_CAPTURE_RULES,
  DEFAULT_CONVERSATION_PLATFORMS,
  collectorEventSchema,
  collectorSettingsSchema,
  eventBatchRequestSchema,
  type CollectorEvent,
  type CollectorSettings
} from "@study-studio/shared";

export type StubOptions = {
  pairingToken?: string;
  /** Event ids that should be rejected with 422 / batch rejected. */
  rejectIds?: Set<string> | string[];
  captureRules?: Partial<CollectorSettings["captureRules"]>;
};

export type StubServer = {
  port: number;
  url: string;
  token: string;
  events: CollectorEvent[];
  presence: unknown[];
  settingsEtag: string;
  settings: CollectorSettings;
  close(): Promise<void>;
  reset(): void;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, if-none-match",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...headers
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse) {
  send(res, 401, { error: "unauthorized" });
}

export async function createStubServer(options: StubOptions = {}): Promise<StubServer> {
  const token = options.pairingToken ?? "stub-token";
  const rejectIds = new Set(options.rejectIds ?? []);
  const settings: CollectorSettings = collectorSettingsSchema.parse({
    captureRules: {
      ...DEFAULT_CAPTURE_RULES,
      preset: "debug",
      minActiveSeconds: 5,
      minScrollDepth: 0,
      minRevisitSeconds: 3,
      captureFromSearch: true,
      aiConversationWindowMinutes: 5,
      ...options.captureRules
    },
    activityTracking: DEFAULT_ACTIVITY_TRACKING,
    conversationPlatforms: DEFAULT_CONVERSATION_PLATFORMS,
    exclusionRules: [],
    builtinListPageRules: [],
    domainCategoryVersion: 1
  });
  let settingsEtag = `W/"settings-1"`;
  const events: CollectorEvent[] = [];
  const presence: unknown[] = [];
  const capturedUrls = new Set<string>();

  const auth = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${token}`;
  };

  const ingestOne = (raw: unknown): { id: string | null; status: "accepted" | "duplicate" | "ignored" | "rejected"; error?: string } => {
    const parsed = collectorEventSchema.safeParse(raw);
    if (!parsed.success) {
      return { id: (raw as { id?: string })?.id ?? null, status: "rejected", error: parsed.error.issues[0]?.message ?? "invalid" };
    }
    const event = parsed.data;
    if (rejectIds.has(event.id)) return { id: event.id, status: "rejected", error: "forced rejection" };
    if (event.type === "page_opened" || event.type === "source_excluded") return { id: event.id, status: "ignored" };
    if (events.some((item) => item.id === event.id)) return { id: event.id, status: "duplicate" };
    if (event.type === "webpage_captured") {
      const canonicalUrl = event.content.canonicalUrl;
      if (capturedUrls.has(canonicalUrl)) return { id: event.id, status: "duplicate" };
      capturedUrls.add(canonicalUrl);
    }
    events.push(event);
    return { id: event.id, status: "accepted" };
  };

  const server: Server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, null);
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (!auth(req) && url.pathname !== "/") return unauthorized(res);

    try {
      if (req.method === "GET" && url.pathname === "/v1/pairing") {
        return send(res, 200, { ok: true, service: "study-studio-stub" });
      }

      if (req.method === "GET" && url.pathname === "/v1/settings") {
        const inm = req.headers["if-none-match"];
        if (inm && inm === settingsEtag) return send(res, 304, null, { etag: settingsEtag });
        return send(res, 200, settings, { etag: settingsEtag });
      }

      if (req.method === "GET" && url.pathname === "/v1/pages") {
        const canonicalUrl = url.searchParams.get("canonicalUrl") ?? "";
        return send(res, 200, { captured: capturedUrls.has(canonicalUrl) });
      }

      if (req.method === "GET" && url.pathname === "/v1/presence") {
        return send(res, 200, { items: presence });
      }

      if (req.method === "POST" && url.pathname === "/v1/presence") {
        const body = JSON.parse(await readBody(req));
        presence.push({ ...body, at: new Date().toISOString() });
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/v1/events") {
        const body = JSON.parse(await readBody(req));
        const result = ingestOne(body);
        if (result.status === "rejected") return send(res, 422, { error: result.error, ...result });
        return send(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/v1/events/batch") {
        const body = JSON.parse(await readBody(req));
        const parsed = eventBatchRequestSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: "invalid batch" });
        const results = parsed.data.events.map((item) => ingestOne(item));
        return send(res, 200, { results });
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      return send(res, 500, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind stub server");

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    token,
    events,
    presence,
    get settingsEtag() {
      return settingsEtag;
    },
    settings,
    reset() {
      events.length = 0;
      presence.length = 0;
      capturedUrls.clear();
      settingsEtag = `W/"settings-${Date.now()}"`;
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}
