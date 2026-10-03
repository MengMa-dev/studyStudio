import type { UIMessage } from "ai";
import {
  CHAT_DATA_PART_TYPES,
  CHAT_ERROR_CODES,
  type ChatCitationsData,
  type ChatContext,
  type ChatErrorCode,
  type ChatOrganizeCardData,
  type ChatPage,
  type ChatProfileCardData
} from "@study-studio/shared";

/** Keys are the `data-*` part names without the prefix (AI SDK convention). */
export type StudyChatDataTypes = {
  citations: ChatCitationsData;
  "organize-card": ChatOrganizeCardData;
  "profile-card": ChatProfileCardData;
};

export type StudyChatMetadata = { context?: ChatContext };

export type StudyChatMessage = UIMessage<StudyChatMetadata, StudyChatDataTypes>;

export const CHAT_PAGE_LABEL: Record<ChatPage, string> = {
  home: "首页",
  wiki: "知识库",
  entry: "词条详情",
  progress: "学习进度",
  inbox: "收集箱",
  item: "条目详情",
  runs: "整理记录"
};

/**
 * Pre-stream HTTP errors arrive as `APICallError` whose message is the JSON body;
 * in-stream errors arrive as the bare `errorText`.
 */
export function chatErrorCode(error: unknown): ChatErrorCode | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const known = (value: unknown): value is ChatErrorCode => typeof value === "string" && (CHAT_ERROR_CODES as readonly string[]).includes(value);
  try {
    const parsed = JSON.parse(message.replace(/^API \d+:\s*/, "")) as { error?: unknown };
    if (known(parsed.error)) return parsed.error;
  } catch {
    /* plain text */
  }
  return CHAT_ERROR_CODES.find((code) => message.includes(code)) ?? null;
}

export function messageText(message: StudyChatMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function citationsOf(message: StudyChatMessage): ChatCitationsData | null {
  for (const part of message.parts) {
    if (part.type === CHAT_DATA_PART_TYPES.citations) return part.data;
  }
  return null;
}

export function isToolPart(part: StudyChatMessage["parts"][number]): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}
