import { z } from "zod";

import { organizeScopeSchema } from "./organize";

/** Single shared session for home + floating chat (09「会话与存储」). */
export const CHAT_SESSION_ID = "main";

export const chatPageSchema = z.enum(["home", "wiki", "entry", "progress", "inbox", "item", "runs"]);
export type ChatPage = z.infer<typeof chatPageSchema>;

export const chatContextSchema = z.object({
  page: chatPageSchema,
  entryId: z.string().optional(),
  itemId: z.string().optional(),
  selectedItemIds: z.array(z.string()).max(500).optional(),
  selectedEntryIds: z.array(z.string()).max(500).optional()
});
export type ChatContext = z.infer<typeof chatContextSchema>;

/** Loose UIMessage shape; the server validates parts with AI SDK `validateUIMessages`. */
export const chatUiMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(z.record(z.string(), z.unknown())),
    metadata: z.unknown().optional()
  })
  .passthrough();

export const chatRequestSchema = z.object({
  message: chatUiMessageSchema,
  context: chatContextSchema,
  allowOverLimit: z.boolean().default(false)
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatMessagesResponseSchema = z.object({
  messages: z.array(chatUiMessageSchema)
});

// ---- custom data parts (AI SDK `data-*` parts) ----

export const chatCitationKindSchema = z.enum(["entry", "item", "day"]);
export type ChatCitationKind = z.infer<typeof chatCitationKindSchema>;

export const chatCitationSchema = z.object({
  n: z.number().int().positive(),
  kind: chatCitationKindSchema,
  /** entryId / itemId / YYYY-MM-DD */
  id: z.string(),
  title: z.string()
});
export type ChatCitation = z.infer<typeof chatCitationSchema>;

/** `data-citations` */
export const chatCitationsDataSchema = z.object({
  citations: z.array(chatCitationSchema),
  /** true when the answer used no learning records (前端标注「非学习记录」). */
  nonRecord: z.boolean()
});
export type ChatCitationsData = z.infer<typeof chatCitationsDataSchema>;

export const chatOrganizeOptionSchema = z.object({
  scope: organizeScopeSchema,
  label: z.string(),
  itemIds: z.array(z.string()).default([]),
  entryIds: z.array(z.string()).default([]),
  /** Display name of the target, e.g. entry name / item title. */
  targetName: z.string().optional()
});
export type ChatOrganizeOption = z.infer<typeof chatOrganizeOptionSchema>;

/** `data-organize-card`: one option → direct confirm; several → user picks first. Never executed server-side. */
export const chatOrganizeCardDataSchema = z.object({
  options: z.array(chatOrganizeOptionSchema).min(1),
  requirement: z.string().max(2000).optional()
});
export type ChatOrganizeCardData = z.infer<typeof chatOrganizeCardDataSchema>;

/** `data-profile-card`: profile already saved; `previous` lets the UI undo. */
export const chatProfileCardDataSchema = z.object({
  role: z.string().optional(),
  direction: z.string().optional(),
  previous: z.object({
    role: z.string(),
    directions: z.array(z.object({ id: z.string(), text: z.string(), expiresAt: z.string() }))
  })
});
export type ChatProfileCardData = z.infer<typeof chatProfileCardDataSchema>;

/**
 * Citation markers models actually emit: `[1]`, `【1】`, `[1, 2]`, `【8、9】`, `【1†ref1】`.
 * A following `(` is excluded so Markdown links like `[1](url)` are left alone.
 */
export const CHAT_CITATION_MARKER = /[[【](\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)(?:†[^\]】\n]{0,20})?[\]】](?!\()/g;

export function citationMarkerNumbers(raw: string): number[] {
  return raw.split(/[,，、]/).map((part) => Number(part.trim()));
}

export const CHAT_DATA_PART_TYPES = {
  citations: "data-citations",
  organizeCard: "data-organize-card",
  profileCard: "data-profile-card"
} as const;

/** Error codes surfaced to the UI (stream error text or HTTP JSON `error`). */
export const CHAT_ERROR_CODES = ["chat_model_not_configured", "usage_limit_exceeded", "model_failed"] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];
