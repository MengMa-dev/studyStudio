/**
 * 64-bit SimHash for near-duplicate detection (07 ④).
 * Features: whitespace / CJK-aware tokens; no external deps.
 */

const CJK = /[\u3400-\u9fff]/gu;
const LATIN = /[a-z0-9_]+/giu;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** Tokenize for SimHash: latin words lowercased + overlapping CJK bigrams. */
export function tokenizeForSimhash(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(LATIN)) {
    if (match[0].length >= 2) tokens.push(match[0]);
  }
  for (const match of text.matchAll(CJK)) {
    const run = match[0];
    if (run.length === 1) tokens.push(run);
    else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Compute a 64-bit SimHash fingerprint of `text`. */
export function computeSimhash(text: string): bigint {
  const tokens = tokenizeForSimhash(text);
  if (tokens.length === 0) return 0n;
  const weights = new Int32Array(64);
  for (const token of tokens) {
    const h = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) {
      weights[bit]! += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((weights[bit] ?? 0) > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

export function parseSimhash(value: bigint | string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function simhashNearDuplicate(a: bigint, b: bigint, maxDistance: number): boolean {
  return hammingDistance(a, b) <= maxDistance;
}
