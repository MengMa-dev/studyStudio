import { Chat } from "@ai-sdk/react";
import { create } from "zustand";
import { CHAT_SESSION_ID, type ChatContext } from "@study-studio/shared";
import { api } from "@/api";
import type { StudyChatMessage } from "@/lib/chat";

let currentContext: ChatContext = { page: "home" };

/** Written by `ChatContextSync` on every route / selection change; read by the transport at send time. */
export function setChatContext(context: ChatContext): void {
  currentContext = context;
}

export function getChatContext(): ChatContext {
  return currentContext;
}

/** Home page and floating dock both render this instance, so their messages stay in sync. */
export const chat = new Chat<StudyChatMessage>({
  id: CHAT_SESSION_ID,
  transport: api.createChatTransport({ getContext: getChatContext })
});

type ChatUiStore = {
  dockOpen: boolean;
  historyLoaded: boolean;
  setDockOpen: (open: boolean) => void;
};

export const useChatUiStore = create<ChatUiStore>((set) => ({
  dockOpen: false,
  historyLoaded: false,
  setDockOpen: (open) => set({ dockOpen: open })
}));

let historyPromise: Promise<void> | null = null;

export function loadChatHistory(): Promise<void> {
  historyPromise ??= api
    .getChatMessages()
    .then(({ messages }) => {
      // A message sent before history arrived wins; replaying would drop it.
      if (chat.messages.length === 0 && chat.status === "ready") chat.messages = messages;
    })
    .catch(() => undefined)
    .finally(() => useChatUiStore.setState({ historyLoaded: true }));
  return historyPromise;
}

export async function clearChatSession(): Promise<void> {
  if (chat.status === "streaming" || chat.status === "submitted") await chat.stop();
  await api.clearChat();
  chat.messages = [];
  chat.clearError();
}

export async function resetChatSessionForTests(): Promise<void> {
  await chat.stop();
  chat.messages = [];
  chat.clearError();
  historyPromise = null;
  currentContext = { page: "home" };
  useChatUiStore.setState({ dockOpen: false, historyLoaded: false });
}
