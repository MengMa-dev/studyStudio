const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** Space-joined word segments so unicode61 FTS can index Chinese words. */
export function segmentText(text: string): string {
  return [...segmenter.segment(text.toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .join(" ");
}

/** Individual word-like tokens (lowercased). */
export function tokenize(text: string): string[] {
  return [...segmenter.segment(text.toLowerCase())].filter((part) => part.isWordLike).map((part) => part.segment);
}

/** Count CJK / word-like characters for short-query detection (< 3). */
export function queryCharLength(text: string): number {
  const compact = text.replace(/\s+/g, "");
  return [...compact].length;
}
