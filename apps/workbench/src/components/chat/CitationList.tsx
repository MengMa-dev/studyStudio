import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ChatCitation } from "@study-studio/shared";

const KIND_LABEL: Record<ChatCitation["kind"], string> = { entry: "词条", item: "条目", day: "学习日" };

export function CitationLink({ citation, className, children }: { citation: ChatCitation; className?: string; children: ReactNode }) {
  const title = `${KIND_LABEL[citation.kind]}：${citation.title}`;
  switch (citation.kind) {
    case "entry":
      return (
        <Link to="/wiki/$entryId" params={{ entryId: citation.id }} className={className} title={title}>
          {children}
        </Link>
      );
    case "item":
      return (
        <Link to="/item/$itemId" params={{ itemId: citation.id }} className={className} title={title}>
          {children}
        </Link>
      );
    case "day":
      return (
        <Link to="/progress" className={className} title={title}>
          {children}
        </Link>
      );
  }
}

export function CitationList({ citations }: { citations: ChatCitation[] }) {
  if (!citations.length) return null;
  return (
    <div className="basis" aria-label="依据">
      <span>依据：</span>
      {citations.map((citation) => (
        <CitationLink key={citation.n} citation={citation} className="chat-source">
          <b>[{citation.n}]</b>
          <span className="faint">{KIND_LABEL[citation.kind]}</span>
          <span className="chat-source-title">{citation.title}</span>
        </CitationLink>
      ))}
    </div>
  );
}
