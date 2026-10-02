import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

type Props = {
  markdown: string;
};

export function MarkdownView({ markdown }: Props) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function Tag({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
