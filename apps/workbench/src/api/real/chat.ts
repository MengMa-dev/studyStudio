import { DefaultChatTransport, type ChatTransport } from "ai";
import { z } from "zod";
import { chatMessagesResponseSchema, type ChatContext, type ChatRequest } from "@study-studio/shared";
import type { StudyChatMessage } from "@/lib/chat";

import { request } from "./http";

const CHAT_API = {
  send: "/v1/chat",
  messages: "/v1/chat/messages"
} as const;

export type ChatTransportOptions = {
  /** Read at send time so the request carries the page the user is on right now. */
  getContext: () => ChatContext;
};

export const realChatApi = {
  async getChatMessages() {
    const data = await request(CHAT_API.messages, undefined, chatMessagesResponseSchema);
    return { messages: data.messages as unknown as StudyChatMessage[] };
  },

  async clearChat() {
    await request(CHAT_API.messages, { method: "DELETE" }, z.unknown());
    return { ok: true as const };
  },

  /** History lives on the server; only the latest user message is sent. */
  createChatTransport({ getContext }: ChatTransportOptions): ChatTransport<StudyChatMessage> {
    return new DefaultChatTransport<StudyChatMessage>({
      api: CHAT_API.send,
      credentials: "include",
      prepareSendMessagesRequest: ({ messages, body }) => {
        const message = messages.findLast((candidate) => candidate.role === "user");
        const payload: ChatRequest = {
          message: message as unknown as ChatRequest["message"],
          context: getContext(),
          allowOverLimit: Boolean((body as { allowOverLimit?: boolean } | undefined)?.allowOverLimit)
        };
        return { body: payload };
      }
    });
  }
};
