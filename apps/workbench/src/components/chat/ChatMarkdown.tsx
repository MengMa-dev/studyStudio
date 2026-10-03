import { useMemo, type ComponentPropsWithoutRef } from "react";
import type { Components } from "react-markdown";
import type { ChatCitation } from "@study-studio/shared";
import { MarkdownView } from "@/components/ui/MarkdownView";
import { CitationLink } from "./CitationList";

const CITE_HREF = "#cite-";

/** `[n]` → link when n is a known citation; unknown markers are escaped so they stay plain text. */
export function linkCitations(markdown: string, known: Set<number>): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(/\[(\d{1,3})\](?!\()/g, (match, raw: string) => (known.has(Number(raw)) ? `[${raw}](${CITE_HREF}${raw})` : `\\[${raw}\\]`));
    })
    .join("\n");
}

export function ChatMarkdown({ markdown, citations }: { markdown: string; citations: ChatCitation[] }) {
  const byNumber = useMemo(() => new Map(citations.map((citation) => [citation.n, citation])), [citations]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
        const citation = href?.startsWith(CITE_HREF) ? byNumber.get(Number(href.slice(CITE_HREF.length))) : undefined;
        if (citation) {
          return (
            <sup className="chat-cite">
              <CitationLink citation={citation}>{citation.n}</CitationLink>
            </sup>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...rest}>
            {children}
          </a>
        );
      }
    }),
    [byNumber]
  );
  const source = useMemo(() => linkCitations(markdown, new Set(byNumber.keys())), [markdown, byNumber]);

  return <MarkdownView markdown={source} className="chat-prose" components={components} />;
}
