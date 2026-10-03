/** Automatic mastery estimation (08「掌握度」). Pure; callers gather the signals. */

export type MasterySignals = {
  /** Surviving source items (`kb_entry_sources` joined to non-deleted `items`). */
  sourceCount: number;
  /** Sum of `items.reading_total_seconds` over those source items. */
  readingSeconds: number;
  /** Conversation (问答) source items. */
  qaCount: number;
  /** Entry notes plus item notes on source items, excluding deleted. */
  noteCount: number;
};

export const MASTERY_WEIGHTS = { sources: 0.35, reading: 0.35, qa: 0.2, notes: 0.1 } as const;

/** Saturation constants `k` in `1 - exp(-x / k)`: x = k gives ≈ 0.63 of that factor. */
export const MASTERY_K = { sources: 3, readingSeconds: 1800, qa: 2, notes: 2 } as const;

/** Directory / category panel threshold for「薄弱词条」. */
export const WEAK_MASTERY_THRESHOLD = 0.4;

/** Same cut as the workbench「熟悉」label (`apps/workbench/src/lib/kb.ts`). */
export const FAMILIAR_MASTERY_THRESHOLD = 0.65;

export const EMPTY_MASTERY_SIGNALS: MasterySignals = { sourceCount: 0, readingSeconds: 0, qaCount: 0, noteCount: 0 };

export function saturate(x: number, k: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return 1 - Math.exp(-x / k);
}

export function clampMastery(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Without any source the previous value is kept (may be null). */
export function estimateMastery(signals: MasterySignals, previous: number | null): number | null {
  if (signals.sourceCount <= 0) return previous === null ? null : clampMastery(previous);
  const score =
    MASTERY_WEIGHTS.sources * saturate(signals.sourceCount, MASTERY_K.sources) +
    MASTERY_WEIGHTS.reading * saturate(signals.readingSeconds, MASTERY_K.readingSeconds) +
    MASTERY_WEIGHTS.qa * saturate(signals.qaCount, MASTERY_K.qa) +
    MASTERY_WEIGHTS.notes * saturate(signals.noteCount, MASTERY_K.notes);
  return Math.round(clampMastery(score) * 1000) / 1000;
}

/** `user` keeps the manual value; `auto` (or unknown) is re-estimated. */
export function effectiveMastery(stored: number | null, source: string | null, signals: MasterySignals): number | null {
  if (source === "user") return stored === null ? null : clampMastery(stored);
  return estimateMastery(signals, stored);
}
