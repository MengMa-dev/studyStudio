import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

type Props = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  minHeight?: number;
};

const theme = EditorView.theme({
  "&": { border: "1px solid var(--border)", borderRadius: "8px", background: "var(--panel)", fontSize: "13px" },
  "&.cm-focused": { outline: "2px solid var(--primary-soft)", borderColor: "var(--primary)" },
  ".cm-content": { fontFamily: '"SF Mono", Menlo, monospace', lineHeight: "1.65" },
  ".cm-gutters": { background: "var(--bg)", borderRight: "1px solid var(--border)", color: "var(--faint)", borderRadius: "8px 0 0 8px" }
});

/** CodeMirror 6 Markdown editor: Markdown is stored as-is, so code blocks and formulas round-trip losslessly (08 S16). */
export function MarkdownEditor({ value, onChange, ariaLabel = "Markdown 编辑器", minHeight = 360 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        theme,
        EditorView.theme({ ".cm-scroller": { minHeight: `${minHeight}px` } }),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        })
      ]
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor owns its document after mount; external resets go through the effect below.
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="md-editor" data-testid="markdown-editor" />;
}
