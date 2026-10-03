import type { Context, Hono } from "hono";
import { createUIMessageStreamResponse } from "ai";
import { CHAT_SESSION_ID, chatRequestSchema } from "@study-studio/shared";
import { isAiGatewayError } from "../../ai/errors.js";
import type { AppServices } from "../app.js";
import { ChatRequestError, chatErrorCode, startChat } from "../../domains/chat/service.js";
import { clearMessages, listMessages } from "../../domains/chat/store.js";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** CHAT_API (09「接口」). */
export function registerChatRoutes(api: Hono, services: AppServices): void {
  const db = services.appDb.db;

  api.get("/chat/messages", (c) => c.json({ messages: listMessages(db, CHAT_SESSION_ID) }));

  api.delete("/chat/messages", (c) => c.json({ deleted: clearMessages(db, CHAT_SESSION_ID) }));

  api.post("/chat", async (c) => {
    const parsed = chatRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    if (!services.aiGateway) return c.json({ error: "chat_model_not_configured" }, 409);
    try {
      const stream = await startChat({ db, aiGateway: services.aiGateway, searchIndex: services.searchIndex }, parsed.data, c.req.raw.signal);
      return createUIMessageStreamResponse({ stream });
    } catch (error) {
      if (error instanceof ChatRequestError) return c.json({ error: error.code, message: error.message }, 400);
      if (!isAiGatewayError(error)) throw error;
      const code = chatErrorCode(error);
      if (code === "chat_model_not_configured") return c.json({ error: code }, 409);
      if (code === "usage_limit_exceeded") return c.json({ error: code }, 429);
      return c.json({ error: code, message: error.message }, 502);
    }
  });
}
