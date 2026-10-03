import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

type Highlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
  getLoadedLanguages: () => string[];
  loadLanguage: (lang: never) => Promise<void>;
};

const THEME = "github-dark";
let highlighterPromise: Promise<{ highlighter: Highlighter; languages: Set<string> }> | null = null;

/** Shiki is loaded lazily (JS regex engine, web bundle) so pages without code blocks do not pay for it. */
function loadHighlighter() {
  highlighterPromise ??= Promise.all([import("shiki/bundle/web"), import("shiki/engine/javascript")]).then(async ([bundle, engine]) => {
    const highlighter = await bundle.createHighlighter({ themes: [THEME], langs: [], engine: engine.createJavaScriptRegexEngine() });
    return { highlighter: highlighter as unknown as Highlighter, languages: new Set(Object.keys(bundle.bundledLanguages)) };
  });
  return highlighterPromise;
}

async function highlight(code: string, lang: string): Promise<string | null> {
  const { highlighter, languages } = await loadHighlighter();
  if (!languages.has(lang)) return null;
  if (!highlighter.getLoadedLanguages().includes(lang)) await highlighter.loadLanguage(lang as never);
  return highlighter.codeToHtml(code, { lang, theme: THEME });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlight(code, lang)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  if (html) return <div className="shiki-block" data-lang={lang} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre data-lang={lang}>
      <code>{code}</code>
    </pre>
  );
}

function Pre({ children, ...rest }: ComponentPropsWithoutRef<"pre">) {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === "object" && "props" in child) {
    const props = child.props as { className?: string; children?: unknown };
    const lang = /language-([\w-]+)/.exec(props.className ?? "")?.[1];
    if (lang) return <CodeBlock code={String(props.children ?? "").replace(/\n$/, "")} lang={lang.toLowerCase()} />;
  }
  return <pre {...rest}>{children}</pre>;
}

/** Entry body renderer: GFM + KaTeX + Shiki code highlighting (08 正文渲染). */
export function RichMarkdown({ markdown, className = "" }: { markdown: string; className?: string }) {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ pre: Pre }}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
