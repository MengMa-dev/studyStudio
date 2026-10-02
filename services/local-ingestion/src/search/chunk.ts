export type TextChunk = {
  seq: number;
  text: string;
  tokens: number;
};

export type ChunkOptions = {
  /** Soft target size in estimated tokens (default 400). */
  targetTokens?: number;
  /** Hard max tokens before forced split (default 600). */
  maxTokens?: number;
  /** Overlap tokens between consecutive chunks (default 40). */
  overlapTokens?: number;
};

/** Rough token estimate: CJK ≈ 1 char/token, otherwise ≈ 4 chars/token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk += 1;
    else if (/\s/.test(ch)) continue;
    else other += 1;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|(?=^#{1,6}\s)/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Split markdown/plain text into chunks for `chunks` / FTS / embedding indexes.
 * Prefers paragraph / heading boundaries; merges small pieces up to targetTokens.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const targetTokens = options.targetTokens ?? 400;
  const maxTokens = options.maxTokens ?? 600;
  const overlapTokens = options.overlapTokens ?? 40;
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return [];

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= maxTokens) {
      pieces.push(paragraph);
      continue;
    }
    // Hard-split long paragraphs by sentences / lines.
    const sentences = paragraph.split(/(?<=[。！？.!?])\s*|\n+/).filter((s) => s.trim());
    let buf = "";
    for (const sentence of sentences) {
      const next = buf ? `${buf}${sentence}` : sentence;
      if (estimateTokens(next) > maxTokens && buf) {
        pieces.push(buf);
        buf = sentence;
      } else {
        buf = next;
      }
    }
    if (buf) pieces.push(buf);
  }

  const chunks: TextChunk[] = [];
  let current = "";
  let currentTokens = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (!trimmed) return;
    chunks.push({ seq: chunks.length, text: trimmed, tokens: estimateTokens(trimmed) });
    if (overlapTokens > 0 && chunks.length > 0) {
      const overlap = takeOverlap(trimmed, overlapTokens);
      current = overlap;
      currentTokens = estimateTokens(overlap);
    } else {
      current = "";
      currentTokens = 0;
    }
  };

  for (const piece of pieces) {
    const pieceTokens = estimateTokens(piece);
    if (currentTokens + pieceTokens > targetTokens && current) {
      flush();
    }
    current = current ? `${current}\n\n${piece}` : piece;
    currentTokens = estimateTokens(current);
    if (currentTokens >= maxTokens) flush();
  }
  if (current.trim()) {
    chunks.push({ seq: chunks.length, text: current.trim(), tokens: estimateTokens(current.trim()) });
  }
  return chunks;
}

function takeOverlap(text: string, tokens: number): string {
  const chars = [...text];
  // Approximate: take from the end until estimateTokens hits target.
  let start = Math.max(0, chars.length - tokens * 2);
  let slice = chars.slice(start).join("");
  while (start > 0 && estimateTokens(slice) < tokens) {
    start = Math.max(0, start - 20);
    slice = chars.slice(start).join("");
  }
  return slice.trim();
}

export function chunkId(ownerType: string, ownerId: string, seq: number): string {
  return `${ownerType}:${ownerId}:${seq}`;
}
