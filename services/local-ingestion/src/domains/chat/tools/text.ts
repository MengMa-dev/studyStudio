export const DETAIL_TEXT_LIMIT = 6000;
export const SNIPPET_LIMIT = 300;

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const value = text.trim();
  return value.length > limit ? { text: `${value.slice(0, limit)}…`, truncated: true } : { text: value, truncated: false };
}

export function snippet(text: string, limit = SNIPPET_LIMIT): string {
  return truncate(text.replace(/\s+/g, " "), limit).text;
}

export const roundMastery = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);
