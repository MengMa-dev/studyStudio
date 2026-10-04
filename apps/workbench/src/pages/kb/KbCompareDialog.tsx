import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { KbEntryDetail, KbEntrySource } from "@study-studio/shared";
import { api } from "@/api";
import { MarkdownView } from "@/components/ui/MarkdownView";
import { Modal } from "@/components/ui/Modal";
import { formatCapturedAt } from "@/lib/format";
import { SOURCE_KIND_LABEL } from "@/lib/kb";
import { KbEntryBody } from "./KbEntryBody";

type Props = {
  entry: KbEntryDetail;
  source: KbEntrySource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function KbCompareDialog({ entry, source, open, onOpenChange }: Props) {
  const item = useQuery({ queryKey: ["item", source.itemId], queryFn: () => api.getInboxItem(source.itemId), enabled: open });

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`对比：${entry.name}`} className="modal-full kb-compare">
      <button type="button" className="btn sm ghost kb-compare-close" aria-label="关闭对比" onClick={() => onOpenChange(false)}>
        ✕
      </button>
      <div className="kb-compare-grid">
        <section className="kb-compare-pane" aria-label="知识库整理内容">
          <div className="kb-compare-head">
            <span className="tag blue">知识库整理</span>
            <span className="kb-compare-name">{entry.name}</span>
          </div>
          <div className="kb-compare-body wiki-article">
            <KbEntryBody entry={entry} />
          </div>
        </section>
        <section className="kb-compare-pane" aria-label="来源原文">
          <div className="kb-compare-head">
            <span className="tag">原文</span>
            <span className="kb-compare-name" title={source.title}>
              {source.title}
            </span>
            <span className="small faint">
              {SOURCE_KIND_LABEL[source.sourceKind]}
              {source.addedAt ? ` · ${formatCapturedAt(source.addedAt)}` : ""}
            </span>
            <div className="grow" />
            <Link to="/item/$itemId" params={{ itemId: source.itemId }} className="btn sm ghost">
              详情
            </Link>
            {source.url ? (
              <a className="btn sm ghost" href={source.url} target="_blank" rel="noreferrer">
                打开原文 ↗
              </a>
            ) : null}
          </div>
          <div className="kb-compare-body">
            {source.evidence.length ? (
              <details className="kb-compare-evidence">
                <summary className="small muted">整理时引用的摘录（{source.evidence.length}）</summary>
                {source.evidence.map((evidence, index) => (
                  <blockquote key={index} className="kb-evidence">
                    {evidence.question ? <div className="kb-evidence-q">问：{evidence.question}</div> : null}
                    <div>{evidence.quote}</div>
                  </blockquote>
                ))}
              </details>
            ) : null}
            {item.isError ? (
              <div className="empty">原文加载失败或已删除。</div>
            ) : !item.data ? (
              <div className="empty">加载中…</div>
            ) : (
              <>
                {item.data.type === "conversation" && item.data.question ? <div className="qa-q">{item.data.question}</div> : null}
                {item.data.reasoning ? (
                  <details className="reasoning">
                    <summary>思考过程</summary>
                    <div style={{ marginTop: 6 }}>{item.data.reasoning}</div>
                  </details>
                ) : null}
                {item.data.markdown ? <MarkdownView markdown={item.data.markdown} /> : <div className="small faint">原文无正文内容</div>}
              </>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}
