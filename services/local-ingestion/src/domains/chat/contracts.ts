import type { DatabaseSync } from "node:sqlite";
import type { ToolSet } from "ai";
import type { ChatCitation, ChatCitationKind, ChatContext, ChatOrganizeCardData, ChatProfileCardData } from "@study-studio/shared";
import type { AiGateway } from "../../ai/gateway.js";
import type { SearchIndex } from "../../search/index-api.js";

/**
 * Per-request citation registry (09「引用」). Tools register every object they return
 * and put the returned `n` into the tool result as `ref`.
 */
export interface CitationRegistry {
  register(ref: { kind: ChatCitationKind; id: string; title: string }): number;
  /** Keep only `[n]` markers in `text` that exist in the registry, ordered by n. */
  resolve(text: string): ChatCitation[];
  /** Number of objects registered by retrieval tools in this request. */
  size(): number;
}

/** Custom data parts tools may emit into the UI message stream. */
export type ChatDataPartEmit = { type: "organize-card"; data: ChatOrganizeCardData } | { type: "profile-card"; data: ChatProfileCardData };

export interface ChatToolDeps {
  db: DatabaseSync;
  searchIndex?: SearchIndex;
  aiGateway?: AiGateway;
  now?: () => Date;
}

export interface ChatToolRequestContext {
  context: ChatContext;
  registry: CitationRegistry;
  emit: (part: ChatDataPartEmit) => void;
}

export const CHAT_TOOL_NAMES = [
  "query_timeline",
  "search_knowledge",
  "get_entry",
  "get_item",
  "list_mastery",
  "propose_organize",
  "record_learner_profile"
] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/**
 * Implemented in `./tools/index.ts`. Returned tools are AI SDK `tool({ inputSchema, execute })`;
 * the no-tools fallback path calls `tools[name].execute(input, opts)` directly.
 */
export type CreateChatTools = (deps: ChatToolDeps, req: ChatToolRequestContext) => ToolSet & Record<ChatToolName, unknown>;
