import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import type { QueryKey } from "@tanstack/react-query";
import type { KbEntryDetail, KbEntrySection, KbEntrySource, NoteSummary } from "@study-studio/shared";
import { NotesList } from "@/components/notes/NotesCard";
import { formatCapturedAt, itemTypeLabel, siteShort } from "@/lib/format";
import { SOURCE_KIND_LABEL } from "@/lib/kb";

const NARROW = "(max-width: 1099px)";
const GAP = 12;

export function useNarrowMargin(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

type SectionProps = {
  entry: KbEntryDetail;
  section: KbEntrySection;
  notes: NoteSummary[];
  invalidateKey: QueryKey;
  onCompare: (source: KbEntrySource) => void;
};

export function SectionMargin({ entry, section, notes, invalidateKey, onCompare }: SectionProps) {
  const sources = section.sourceItemIds.flatMap((id) => entry.sources.filter((source) => source.itemId === id));
  return (
    <div className="kb-margin-group" data-margin-for={section.id}>
      {sources.map((source) => (
        <SourceCard key={source.itemId} source={source} onCompare={onCompare} />
      ))}
      <NotesList
        scope="entry"
        targetId={entry.id}
        anchor={section.id}
        notes={notes}
        invalidateKey={invalidateKey}
        placeholder={`给「${section.heading}」写备注…`}
        compact
      />
    </div>
  );
}

export function OtherSources({ entry, onCompare }: { entry: KbEntryDetail; onCompare: (source: KbEntrySource) => void }) {
  const inSections = new Set(entry.sections.flatMap((section) => section.sourceItemIds));
  const others = entry.sources.filter((source) => !inSections.has(source.itemId));
  if (!others.length) return null;
  return (
    <div className="kb-margin-group kb-margin-others" data-margin-for="">
      <div className="small faint">其他来源</div>
      {others.map((source) => (
        <SourceCard key={source.itemId} source={source} onCompare={onCompare} />
      ))}
    </div>
  );
}

function SourceCard({ source, onCompare }: { source: KbEntrySource; onCompare: (source: KbEntrySource) => void }) {
  const icon = siteShort(source.site);
  return (
    <div className="kb-source">
      <Link to="/item/$itemId" params={{ itemId: source.itemId }} className="row kb-source-head">
        <span className="src-icon" style={{ background: icon.color, width: 22, height: 22, fontSize: 10 }}>
          {icon.short}
        </span>
        <span className="grow kb-source-title" title={source.title}>
          {source.title}
        </span>
      </Link>
      <div className="small faint">
        {itemTypeLabel(source.type)} · {SOURCE_KIND_LABEL[source.sourceKind]}
        {source.addedAt ? ` · ${formatCapturedAt(source.addedAt)}` : ""}
      </div>
      {source.evidence
        .filter((evidence, index, all) => evidence.question && all.findIndex((other) => other.question === evidence.question) === index)
        .map((evidence, index) => (
          <Link key={index} to="/item/$itemId" params={{ itemId: evidence.turnItemId ?? source.itemId }} className="small kb-evidence-q">
            问：{evidence.question}
          </Link>
        ))}
      <button type="button" className="btn sm ghost kb-source-compare" title="对比整理内容与原文" onClick={() => onCompare(source)}>
        对比原文
      </button>
    </div>
  );
}

type ColumnProps = {
  entry: KbEntryDetail;
  bodyRef: RefObject<HTMLElement | null>;
  notesFor: (sectionId: string) => NoteSummary[];
  invalidateKey: QueryKey;
  onCompare: (source: KbEntrySource) => void;
};

/** Wide-screen margin: each group's top aligns with its section heading; overlapping groups are pushed down. */
export function KbMarginColumn({ entry, bodyRef, notesFor, invalidateKey, onCompare }: ColumnProps) {
  const columnRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const column = columnRef.current;
    const body = bodyRef.current;
    if (!column || !body) return;
    let frame = 0;
    const layout = () => {
      const base = column.getBoundingClientRect().top;
      const anchors = new Map<string, Element>();
      for (const section of body.querySelectorAll<HTMLElement>("[data-section-id]")) {
        anchors.set(section.dataset.sectionId!, section.querySelector("h2") ?? section);
      }
      let bottom = 0;
      for (const group of column.querySelectorAll<HTMLElement>("[data-margin-for]")) {
        const anchor = anchors.get(group.dataset.marginFor!);
        const top = Math.max(anchor ? anchor.getBoundingClientRect().top - base : 0, bottom);
        group.style.top = `${top}px`;
        bottom = top + group.offsetHeight + GAP;
      }
      column.style.minHeight = `${bottom}px`;
    };
    layout();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    });
    observer.observe(body);
    column.querySelectorAll("[data-margin-for]").forEach((group) => observer.observe(group));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [entry, bodyRef]);

  return (
    <aside className="kb-margin" ref={columnRef} aria-label="边注">
      {entry.sections.map((section) => (
        <SectionMargin key={section.id} entry={entry} section={section} notes={notesFor(section.id)} invalidateKey={invalidateKey} onCompare={onCompare} />
      ))}
      <OtherSources entry={entry} onCompare={onCompare} />
    </aside>
  );
}
