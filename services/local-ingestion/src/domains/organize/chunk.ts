import type { ItemExposureRow } from "../../db/types.js";
import { chunkText, estimateTokens } from "../../search/chunk.js";
import { normalizeHeading } from "./normalize.js";
import type { WorkUnit } from "./process.js";

/** ⑤ S2 input chunks (15): documents by heading / paragraph boundaries, conversation threads by whole turns. */

export const CHUNK_TOKENS = 6_000;
const CHUNK_MAX_TOKENS = 8_000;

export type ChunkTurn = { turn_item_id: string; turn_index: number; question: string; answer: string };

export type ContentChunk = {
  index: number;
  total: number;
  /** Heading stack at the chunk start (headings inside the chunk are in its text). */
  heading_path: string[];
  text: string | null;
  turns: ChunkTurn[] | null;
  /** Conversation: last question of the previous chunk, for resolving references. */
  context_question: string | null;
};

function exposureLabel(row: ItemExposureRow | undefined): string | null {
  if (!row) return null;
  const coverage = row.coverage ?? 0;
  const seconds = row.exposed_seconds ?? 0;
  if (coverage >= 0.5) return "高";
  if (coverage > 0 || seconds > 0) return "低";
  return "无";
}

/** Annotate headings with `[露出:高|低|无]` from `item_exposure` (no-op without exposure data). */
export function annotateExposure(markdown: string, exposure: ItemExposureRow[]): string {
  if (exposure.length === 0) return markdown;
  const byHeading = new Map(exposure.filter((row) => row.heading).map((row) => [normalizeHeading(row.heading!), row]));
  return markdown
    .split("\n")
    .map((line) => {
      if (!/^#{1,6}\s+\S/.test(line)) return line;
      const label = exposureLabel(byHeading.get(normalizeHeading(line)));
      return label ? `${line.trimEnd()} [露出:${label}]` : line;
    })
    .join("\n");
}

/** Tracks the markdown heading stack across chunks, ignoring `#` lines inside code fences. */
class HeadingStack {
  private stack: Array<{ level: number; text: string }> = [];
  private fenced = false;

  path(): string[] {
    return this.stack.map((entry) => entry.text);
  }

  consume(text: string): void {
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {
        this.fenced = !this.fenced;
        continue;
      }
      if (this.fenced) continue;
      const match = /^(#{1,6})\s+\S/.exec(line);
      if (!match) continue;
      const level = match[1]!.length;
      this.stack = this.stack.filter((entry) => entry.level < level);
      this.stack.push({ level, text: line.trim() });
    }
  }
}

function documentChunks(text: string): Array<Omit<ContentChunk, "index" | "total">> {
  const pieces = chunkText(text, { targetTokens: CHUNK_TOKENS, maxTokens: CHUNK_MAX_TOKENS, overlapTokens: 0 });
  const headings = new HeadingStack();
  return pieces.map((piece) => {
    const heading_path = headings.path();
    headings.consume(piece.text);
    return { heading_path, text: piece.text, turns: null, context_question: null };
  });
}

// ponytail: a single turn above the budget stays whole in its own chunk; split long answers by paragraph if that shows up.
function threadChunks(turns: ChunkTurn[]): Array<Omit<ContentChunk, "index" | "total">> {
  const groups: ChunkTurn[][] = [];
  let used = 0;
  for (const turn of turns) {
    const tokens = estimateTokens(`${turn.question}\n${turn.answer}`);
    const current = groups[groups.length - 1];
    if (current && used + tokens <= CHUNK_TOKENS) {
      current.push(turn);
      used += tokens;
    } else {
      groups.push([turn]);
      used = tokens;
    }
  }
  return groups.map((group, index) => {
    const previous = groups[index - 1];
    return { heading_path: [], text: null, turns: group, context_question: previous ? previous[previous.length - 1]!.question : null };
  });
}

export function chunkUnit(unit: WorkUnit): ContentChunk[] {
  const anchor = unit.items[0]!;
  const raw =
    anchor.type === "conversation"
      ? threadChunks(
          unit.items.map((item, index) => ({ turn_item_id: item.id, turn_index: index + 1, question: item.question ?? item.title, answer: item.body }))
        )
      : documentChunks(annotateExposure(anchor.body, anchor.exposure));
  return raw.map((chunk, index) => ({ ...chunk, index, total: raw.length }));
}
