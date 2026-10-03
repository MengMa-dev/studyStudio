import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  validateUIMessages,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter
} from "ai";
import { CHAT_DATA_PART_TYPES, CHAT_SESSION_ID, type ChatCitationsData, type ChatErrorCode, type ChatRequest } from "@study-studio/shared";
import { TaskModelNotConfiguredError, ProviderNotFoundError, ToolsNotSupportedError, UsageLimitExceededError } from "../../ai/errors.js";
import type { AiGateway } from "../../ai/gateway.js";
import type { StreamChatResult } from "../../ai/types.js";
import type { SearchIndex } from "../../search/index-api.js";
import { createCitationRegistry } from "./citations.js";
import type { ChatDataPartEmit } from "./contracts.js";
import { chatModelKey, isToolsUnsupported, markToolsUnsupported, runFallback } from "./fallback.js";
import { buildChatSystemPrompt } from "./prompt.js";
import { appendMessage, listMessages, truncateAfter } from "./store.js";
import { createChatTools } from "./tools/index.js";

const HISTORY_LIMIT = 20;
/** Rough token budget (~4 chars/token) for replayed history; the newest message is always kept. */
const HISTORY_CHAR_BUDGET = 48_000;
const MAX_STEPS = 5;

export type ChatServiceDeps = {
  db: DatabaseSync;
  aiGateway: AiGateway;
  searchIndex?: SearchIndex;
  now?: () => Date;
};

export class ChatRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatRequestError";
    this.code = code;
  }
}

export function chatErrorCode(error: unknown): ChatErrorCode {
  if (error instanceof UsageLimitExceededError) return "usage_limit_exceeded";
  if (error instanceof TaskModelNotConfiguredError || error instanceof ProviderNotFoundError) return "chat_model_not_configured";
  return "model_failed";
}

export function trimHistory(messages: UIMessage[], budget = HISTORY_CHAR_BUDGET): UIMessage[] {
  const kept: UIMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]!.parts).length;
    if (kept.length > 0 && used + size > budget) break;
    kept.unshift(messages[i]!);
    used += size;
  }
  return kept;
}

function textOf(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function pumpModelStream(writer: UIMessageStreamWriter, result: StreamChatResult["result"]): Promise<string> {
  let text = "";
  // Forwarded chunk by chunk (not writer.merge) so data-citations / finish are written after the last model chunk.
  for await (const chunk of result.toUIMessageStream({ sendStart: false, sendFinish: false, onError: chatErrorCode })) {
    if (chunk.type === "text-delta") text += chunk.delta;
    writer.write(chunk);
  }
  return text;
}

/**
 * POST /v1/chat. Model / limit problems known before streaming throw (route maps them to 409 / 429);
 * anything after that is written into the stream as an error chunk.
 */
export async function startChat(deps: ChatServiceDeps, request: ChatRequest, abortSignal?: AbortSignal): Promise<ReadableStream<UIMessageChunk>> {
  const { db, aiGateway } = deps;
  const now = deps.now ?? (() => new Date());
  let message: UIMessage;
  try {
    [message] = (await validateUIMessages({ messages: [request.message] })) as [UIMessage];
  } catch (error) {
    throw new ChatRequestError("invalid_request", error instanceof Error ? error.message : String(error));
  }
  if (message.role !== "user") throw new ChatRequestError("invalid_request", "message.role must be user");
  const userText = textOf(message).trim();
  if (!userText) throw new ChatRequestError("invalid_request", "message has no text");

  const primary = await aiGateway.prepareChat(request.allowOverLimit);
  appendMessage(db, CHAT_SESSION_ID, { message, context: request.context });
  truncateAfter(db, CHAT_SESSION_ID, message.id);
  const history = trimHistory(listMessages(db, CHAT_SESSION_ID, HISTORY_LIMIT));
  let modelLabel: string | null = null;

  return createUIMessageStream({
    originalMessages: history,
    generateId: randomUUID,
    onError: chatErrorCode,
    execute: async ({ writer }) => {
      const registry = createCitationRegistry();
      const emit = (part: ChatDataPartEmit) => writer.write({ type: `data-${part.type}`, data: part.data });
      const tools = createChatTools({ db, searchIndex: deps.searchIndex, aiGateway, now }, { context: request.context, registry, emit });
      const system = buildChatSystemPrompt(db, request.context, now());
      const messages = await convertToModelMessages(history, { tools, ignoreIncompleteToolCalls: true });
      const fallback = () =>
        runFallback({
          writer,
          tools,
          userText,
          context: request.context,
          gateway: aiGateway,
          system,
          messages,
          allowOverLimit: request.allowOverLimit,
          abortSignal,
          now: now(),
          pump: (result) => pumpModelStream(writer, result)
        });

      writer.write({ type: "start" });
      let text: string;
      if (isToolsUnsupported(chatModelKey(primary.providerId, primary.model))) {
        ({ text, model: modelLabel } = await fallback());
      } else {
        try {
          const chat = await aiGateway.streamChat({
            system,
            messages,
            tools,
            stopWhen: stepCountIs(MAX_STEPS),
            allowOverLimit: request.allowOverLimit,
            abortSignal
          });
          modelLabel = chatModelKey(chat.providerId, chat.model);
          text = await pumpModelStream(writer, chat.result);
        } catch (error) {
          if (!(error instanceof ToolsNotSupportedError)) throw error;
          markToolsUnsupported(chatModelKey(error.providerId, error.model));
          ({ text, model: modelLabel } = await fallback());
        }
      }

      const citations = registry.resolve(text);
      const data: ChatCitationsData = { citations, nonRecord: registry.size() === 0 && citations.length === 0 };
      writer.write({ type: CHAT_DATA_PART_TYPES.citations, data });
      writer.write({ type: "finish" });
    },
    onEnd: ({ responseMessage }) => {
      if (responseMessage.role !== "assistant" || responseMessage.parts.length === 0) return;
      appendMessage(db, CHAT_SESSION_ID, { message: responseMessage, model: modelLabel });
    }
  });
}
