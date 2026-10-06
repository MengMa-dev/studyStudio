import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { parseSections, type KbEntryDetail } from "@study-studio/shared";
import { RichMarkdown } from "@/components/ui/RichMarkdown";

type Props = {
  entry: KbEntryDetail;
  /** Rendered after each marked section (narrow-screen margin). */
  sectionAside?: (sectionId: string) => ReactNode;
};

export function KbEntryBody({ entry, sectionAside }: Props) {
  const { contrasts, faqs } = entry.renderedSections;
  const sections = useMemo(() => parseSections(entry.bodyMarkdown), [entry.bodyMarkdown]);
  return (
    <>
      {entry.summary ? <p className="lead">{entry.summary}</p> : null}
      <h3>正文</h3>
      {sections.length ? null : <RichMarkdown markdown="_暂无正文_" className="wiki-body" />}
      {sections.map((section, index) => (
        <section key={section.id ?? `p-${index}`} className="kb-section" data-section-id={section.id ?? undefined}>
          <RichMarkdown markdown={section.heading === null ? section.markdown : `## ${section.heading}\n\n${section.markdown}`} className="wiki-body" />
          {section.id && sectionAside ? sectionAside(section.id) : null}
        </section>
      ))}
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
