import { Link } from "@tanstack/react-router";
import type { KbEntryDetail } from "@study-studio/shared";
import { RichMarkdown } from "@/components/ui/RichMarkdown";

export function KbEntryBody({ entry }: { entry: KbEntryDetail }) {
  const { contrasts, faqs } = entry.renderedSections;
  return (
    <>
      {entry.summary ? <p className="lead">{entry.summary}</p> : null}
      <h3>正文</h3>
      <RichMarkdown markdown={entry.bodyMarkdown || "_暂无正文_"} className="wiki-body" />
      {contrasts.map((contrast) => (
        <section key={contrast.entryId} className="kb-rendered">
          <h3>
            与{" "}
            <Link to="/wiki/$entryId" params={{ entryId: contrast.entryId }}>
              {contrast.name}
            </Link>{" "}
            的区别
          </h3>
          <p className="wiki-body">{contrast.description}</p>
        </section>
      ))}
      {faqs.length ? (
        <section className="kb-rendered">
          <h3>常见疑问</h3>
          <ul className="wiki-body">
            {faqs.map((faq) => (
              <li key={`${faq.itemId}-${faq.question}`}>
                <Link to="/item/$itemId" params={{ itemId: faq.turnItemId ?? faq.itemId }}>
                  {faq.question}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {entry.completeness?.missing.length ? <div className="small faint kb-missing">尚未覆盖：{entry.completeness.missing.join("、")}</div> : null}
    </>
  );
}
