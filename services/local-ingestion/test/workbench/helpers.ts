import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { collectorEventSchema } from "@study-studio/shared";
import { openDatabase } from "../../src/db/database.js";
import { ingest } from "../../src/domains/capture/ingest.js";
import { PresenceStore } from "../../src/domains/capture/presence.js";
import { createApp, createAuthState } from "../../src/http/app.js";

export const PORT = 43118;
export const TOKEN = "wb-token";

export async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "study-studio-wb-"));
  const appDb = openDatabase({ dataDir, memory: true, skipVector: true });
  t.after(async () => {
    appDb.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const auth = createAuthState(TOKEN, PORT);
  const presence = new PresenceStore();
  const ingestCtx = { app: appDb, minRevisitSeconds: 1 };
  const app = createApp({ appDb, auth, presence, ingestCtx, getPort: () => PORT, workbenchDist: join(dataDir, "missing-dist") });

  const call = async (method: string, path: string, body?: unknown, init: { token?: string; contentType?: string } = {}) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${init.token ?? auth.pairingToken}` };
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array) {
      payload = new Uint8Array(body);
      headers["content-type"] = init.contentType ?? "application/zip";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const response = await app.request(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown };
  };

  const event = (type: string, occurredAt: string, extra: Record<string, unknown>) => {
    const parsed = collectorEventSchema.parse({ id: randomUUID(), schemaVersion: 1, type, occurredAt, ...extra });
    return ingest(ingestCtx, parsed);
  };

  const page = (url: string, title: string, at: string, sessionId?: string) => {
    const result = event("webpage_captured", at, {
      source: { channel: "browser_extension", url, title },
      reason: "threshold",
      sessionId,
      content: {
        title,
        canonicalUrl: url,
        markdown: `# ${title}\n\nbody`,
        plainText: `${title} body `.repeat(20),
        contentHash: randomUUID(),
        extractor: "defuddle",
        media: []
      }
    });
    return String(result.body.itemId);
  };

  const read = (url: string, at: string, seconds: number, sessionId: string) =>
    event("reading_session_closed", at, {
      source: { channel: "browser_extension", url, canonicalUrl: url },
      sessionId,
      readingSignals: { activeDurationSeconds: seconds }
    });

  const qa = (askedAt: string, answeredAt: string, question: string, url = "https://chat.deepseek.com/a/chat/s/1") => {
    const questionId = randomUUID();
    const sent = event("user_message_sent", askedAt, {
      source: { channel: "browser_extension", url },
      message: { plainText: question, contentHash: randomUUID() }
    });
    const sentId = (sent.body.id as string) ?? questionId;
    const result = event("assistant_response_completed", answeredAt, {
      source: { channel: "browser_extension", url },
      replyTo: sentId,
      question: { id: sentId, plainText: question },
      answer: { role: "assistant", plainText: `${question} 的回答`, markdown: `**${question}** 的回答`, contentHash: randomUUID() }
    });
    return String(result.body.itemId);
  };

  const note = (text: string, at: string, activeSourceUrl?: string) => {
    const result = event("user_note", at, {
      source: { channel: "browser_extension", url: activeSourceUrl ?? "https://unrelated.example.com/" },
      note: { text },
      ...(activeSourceUrl ? { context: { activeSourceUrl } } : {})
    });
    return String(result.body.noteId);
  };

  return { app, appDb, db: appDb.db, auth, presence, dataDir, call, page, read, qa, note };
}

/** Local wall-clock time `daysAgo` days before `now`, as ISO. */
export function localAt(now: Date, daysAgo: number, hour: number, minute = 0): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute).toISOString();
}
