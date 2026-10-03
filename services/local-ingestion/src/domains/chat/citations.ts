import type { ChatCitation, ChatCitationKind } from "@study-studio/shared";
import type { CitationRegistry } from "./contracts.js";

/** Same object registered twice keeps its first `n`, so repeated tool calls cite consistently. */
export function createCitationRegistry(): CitationRegistry {
  const byKey = new Map<string, ChatCitation>();
  const byN = new Map<number, ChatCitation>();

  return {
    register(ref: { kind: ChatCitationKind; id: string; title: string }): number {
      const key = `${ref.kind}:${ref.id}`;
      const existing = byKey.get(key);
      if (existing) return existing.n;
      const citation: ChatCitation = { n: byN.size + 1, kind: ref.kind, id: ref.id, title: ref.title };
      byKey.set(key, citation);
      byN.set(citation.n, citation);
      return citation.n;
    },
    resolve(text: string): ChatCitation[] {
      const cited = new Set<number>();
      for (const match of text.matchAll(/\[(\d+)\]/g)) {
        const n = Number(match[1]);
        if (byN.has(n)) cited.add(n);
      }
      return [...cited].sort((a, b) => a - b).map((n) => byN.get(n)!);
    },
    size(): number {
      return byN.size;
    }
  };
}
