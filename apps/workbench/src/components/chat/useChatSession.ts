import { useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { chatErrorCode } from "@/lib/chat";
import { chat, clearChatSession, getChatContext, loadChatHistory, useChatUiStore } from "@/stores/chat";

/** Same key as the AI settings page so saving a model there re-enables the composer. */
const AI_TASKS_KEY = ["ai-tasks"];

export function useChatSession() {
  const { messages, status, error, sendMessage, regenerate, stop, clearError } = useChat({ chat });
  const historyLoaded = useChatUiStore((state) => state.historyLoaded);
  const tasks = useQuery({ queryKey: AI_TASKS_KEY, queryFn: () => api.getAiTasks() });

  useEffect(() => {
    void loadChatHistory();
  }, []);

  const configured = tasks.data
    ? tasks.data.tasks.some((task) => (task.task === "chat" || task.task === "knowledge_processing") && task.providerId !== null)
    : true;
  const busy = status === "submitted" || status === "streaming";

  return {
    messages,
    status,
    busy,
    error,
    errorCode: chatErrorCode(error),
    historyLoaded,
    configured,
    send: (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      void sendMessage({ text: trimmed, metadata: { context: getChatContext() } }).catch(() => undefined);
    },
    stop: () => void stop(),
    retry: () => void regenerate().catch(() => undefined),
    continueOverLimit: () => void regenerate({ body: { allowOverLimit: true } }).catch(() => undefined),
    dismissError: clearError,
    clear: () => void clearChatSession()
  };
}

export type ChatSession = ReturnType<typeof useChatSession>;
