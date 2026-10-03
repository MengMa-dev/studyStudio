import type { DatabaseSync } from "node:sqlite";
import type { InboxItemType } from "@study-studio/shared";
import { getItemDetail } from "../../inbox/detail.js";
import type { CitationRegistry } from "../contracts.js";
import { DETAIL_TEXT_LIMIT, roundMastery, truncate } from "./text.js";

const QUESTION_LIMIT = 2000;
const RELATED_LIMIT = 20;

export type ItemToolResult =
  | {
      ref: number;
      id: string;
      title: string;
      type: InboxItemType;
      url: string | null;
      site: string | null;
      capturedAt: string;
      readingMinutes: number;
      /** Conversation items only: the user's question; `content` is then the answer. */
      question?: string;
      content: string;
      contentTruncated: boolean;
      relatedEntries: { ref: number; id: string; name: string; mastery: number | null }[];
    }
  | { error: "not_found"; id: string };

export function getItem(db: DatabaseSync, registry: CitationRegistry, id: string): ItemToolResult {
  const detail = getItemDetail(db, id);
  if (!detail) return { error: "not_found", id };
  const title = detail.title || detail.id;
  const ref = registry.register({ kind: "item", id: detail.id, title });
  const content = truncate(detail.markdown ?? "", DETAIL_TEXT_LIMIT);
  const result: Extract<ItemToolResult, { ref: number }> = {
    ref,
    id: detail.id,
    title,
    type: detail.type,
    url: detail.url,
    site: detail.site,
    capturedAt: detail.capturedAt,
    readingMinutes: Math.round(detail.readingTotalSeconds / 60),
    content: content.text,
    contentTruncated: content.truncated,
    relatedEntries: detail.relatedEntries.slice(0, RELATED_LIMIT).map((entry) => ({
      ref: registry.register({ kind: "entry", id: entry.id, title: entry.name }),
      id: entry.id,
      name: entry.name,
      mastery: roundMastery(entry.mastery)
    }))
  };
  if (detail.question?.trim()) result.question = truncate(detail.question, QUESTION_LIMIT).text;
  return result;
}
