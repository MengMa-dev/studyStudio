import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SEED_KINDS, type KbEntryDetail, type KbEntryPatch, type KbEntrySource } from "@study-studio/shared";
import { api } from "@/api";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { NotesCard } from "@/components/notes/NotesCard";
import { PendingOrganizeBar } from "@/components/organize/PendingOrganizeBar";
import { formatDateTime, masteryColor, masteryLabel, masteryPercent } from "@/lib/kb";
import { egoGraph } from "@/lib/kb-graph";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { KbCompareDialog } from "./KbCompareDialog";
import { KbDeleteDialog } from "./KbDeleteDialog";
import { KbEntryBody } from "./KbEntryBody";
import { KbGraph } from "./KbGraph";
import { KbMarginColumn, OtherSources, SectionMargin, useNarrowMargin } from "./KbMargin";
import { ConceptChip } from "./KbPreview";
import { KbCategoryTree } from "./KbTree";

const NO_IDS: string[] = [];
const NO_CHECKED = new Set<string>();
const noop = () => {};

type Props = { entryId: string };

export function KbEntryPage({ entryId }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const detailKey = ["kb", "entry", entryId];
  const detail = useQuery({ queryKey: detailKey, queryFn: () => api.getKbEntry(entryId) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [kindDraft, setKindDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [comparing, setComparing] = useState<KbEntrySource | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowMargin();

  useEffect(() => {
    setEditing(false);
    setComparing(null);
  }, [entryId]);

  const save = useMutation({
    mutationFn: (patch: KbEntryPatch) => api.patchKbEntry(entryId, patch),
    onSuccess: async (updated, patch) => {
      queryClient.setQueryData(detailKey, updated);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["kb"] });
      pushToast({ message: patch.bodyMarkdown === undefined ? "已保存" : "已保存，知识点标记为待整理（不会自动整理）" });
    },
    onError: (error) => pushToast({ message: `保存失败：${error instanceof Error ? error.message : String(error)}` })
  });

  if (detail.isError) {
    return (
      <div className="empty">
        词条不存在或已删除。
        <Link to="/wiki">返回知识库</Link>
      </div>
    );
  }
  if (!detail.data) return <div className="empty">加载中…</div>;
  const entry = detail.data;
  const newKind = kindDraft.trim();
  const kindChanged = Boolean(newKind) && newKind !== entry.kind;
  const unsaved = editing && (draft !== entry.bodyMarkdown || kindChanged);
  const sectionIds = new Set(entry.sections.map((section) => section.id));
  const notesFor = (sectionId: string) => entry.notes.filter((note) => note.anchor === sectionId);
  const wholeNotes = entry.notes.filter((note) => !note.anchor || !sectionIds.has(note.anchor));
  const sectionAside = (sectionId: string) => {
    const section = entry.sections.find((candidate) => candidate.id === sectionId);
    return section ? <SectionMargin entry={entry} section={section} notes={notesFor(section.id)} invalidateKey={detailKey} onCompare={setComparing} /> : null;
  };
  const organizeThis = () => openOrganize({ scopes: ["entry"], entryIds: [entry.id], targetName: entry.name });

  return (
    <>
      <div className="back-row kb-entry-head">
        <div className="row wrap small crumbs">
          <Link to="/wiki" search={{ sel: entry.id }} className="btn ghost back-btn">
            <svg
              className="i"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m15 6-6 6 6 6" />
            </svg>
            返回
          </Link>
          <Link to="/wiki">知识库</Link>
          {entry.breadcrumb.map((crumb, index) => {
            const last = index === entry.breadcrumb.length - 1;
            return (
              <span key={`${crumb.type}-${crumb.id ?? index}`} className="row" style={{ gap: 8 }}>
                <span className="faint">/</span>
                {last ? (
                  <span style={{ fontWeight: 600 }}>{crumb.name}</span>
                ) : crumb.type === "entry" && crumb.id ? (
                  <Link to="/wiki/$entryId" params={{ entryId: crumb.id }}>
                    {crumb.name}
                  </Link>
                ) : (
                  <Link to="/wiki" search={{ sel: entry.id }}>
                    {crumb.name}
                  </Link>
                )}
              </span>
            );
          })}
        </div>
        <KbToc activeId={entry.id} />
      </div>

      <div className="grid cols-2 kb-entry-top">
        <EntryGraphCard entryId={entry.id} />
        <MasteryCard entry={entry} />
      </div>

      <div className="stack">
        <div className="card wiki-article">
          <div className="row">
            <h1>{entry.name}</h1>
            <div className="grow" />
            {editing ? (
              <>
                <span className="editing-badge">{unsaved ? "编辑中 · 未保存" : "编辑中"}</span>
                <button type="button" className="btn sm" onClick={() => setEditing(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={save.isPending}
                  onClick={() => {
                    const patch = {
                      ...(draft !== entry.bodyMarkdown && { bodyMarkdown: draft }),
                      ...(kindChanged && { kind: newKind as KbEntryPatch["kind"] })
                    };
                    if (Object.keys(patch).length) save.mutate(patch);
                    else setEditing(false);
                  }}
                >
                  保存
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setDraft(entry.bodyMarkdown);
                    setKindDraft(entry.kind);
                    setEditing(true);
                  }}
                >
                  编辑
                </button>
                <button type="button" className="btn sm" data-organize-scope="entry" onClick={organizeThis}>
                  ✦ 重新整理
                </button>
                <details className="more-menu">
                  <summary className="btn sm" title="更多操作" aria-label="更多操作">
                    ⋯
                  </summary>
                  <div className="menu-pop">
                    <Link to="/wiki" search={{ sel: entry.id }}>
                      在图谱中查看
                    </Link>
                    <button type="button" className="danger" onClick={() => setDeleteOpen(true)}>
                      删除知识点
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>
          {entry.aliases.length ? (
            <div className="muted small" style={{ marginTop: 4 }}>
              又称：{entry.aliases.join(" · ")}
            </div>
          ) : null}
          <div className="chips" style={{ marginTop: 10 }}>
            {editing ? (
              <select className="input" style={{ width: 120 }} aria-label="类型" value={kindDraft} onChange={(event) => setKindDraft(event.target.value)}>
                {(SEED_KINDS as readonly string[]).includes(kindDraft) ? null : <option value={kindDraft}>{kindDraft}</option>}
                {SEED_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag blue">{entry.kind}</span>
            )}
            <span className="tag">{entry.categoryName ?? "未归类"}</span>
            {entry.userEdited ? <span className="tag purple">✎ 手动编辑过</span> : null}
            {entry.stale ? <span className="tag orange">↻ 来源有变化，下次整理更新</span> : null}
            {entry.orphan ? <span className="tag red">无来源</span> : null}
          </div>

          {editing ? null : (
            <>
              {entry.suggestRewrite ? (
                <div className="rewrite-bar" role="note">
                  已累积 {entry.patchCount} 次补丁，正文结构可能变散，建议整理结构
                  <div className="grow" />
                  <button type="button" className="btn sm" data-organize-scope="entry" onClick={organizeThis}>
                    ✦ 整理结构
                  </button>
                </div>
              ) : null}
              <PendingOrganizeBar edited={entry.dirty} onOrganize={organizeThis} />
            </>
          )}

          {editing ? (
            <div style={{ marginTop: 14 }}>
              <MarkdownEditor value={draft} onChange={setDraft} ariaLabel="词条正文" />
              <div className="small faint" style={{ marginTop: 8 }}>
                Markdown 原样保存，支持代码块与 $公式$。请勿删除 <code>{"<!-- section … -->"}</code>{" "}
                行（章节来源与边注依赖它）。保存后不会自动整理；之后整理只追加新章节或调整章节顺序，不改你写的文字。
              </div>
            </div>
          ) : (
            <div className={narrow ? "kb-entry-layout narrow" : "kb-entry-layout"}>
              <div className="kb-entry-main" ref={bodyRef}>
                <KbEntryBody entry={entry} sectionAside={narrow ? sectionAside : undefined} />
                {narrow ? <OtherSources entry={entry} onCompare={setComparing} /> : null}
              </div>
              {narrow ? null : <KbMarginColumn entry={entry} bodyRef={bodyRef} notesFor={notesFor} invalidateKey={detailKey} onCompare={setComparing} />}
            </div>
          )}

          <div className="small faint" style={{ marginTop: 20 }}>
            最后更新 {formatDateTime(entry.updatedAt)} · 累计 {entry.patchCount} 次补丁 · 内容由 {entry.sources.length} 条学习记录生成
          </div>
        </div>

        <div className={entry.sameCategory.length ? "grid cols-main-side" : "stack"}>
          <NotesCard
            scope="entry"
            targetId={entry.id}
            title="整篇备注"
            hint="针对整篇知识点的理解与疑问；章节备注写在正文右侧边注。备注不影响整理，供问答、检索与 Agent 参考"
            notes={wholeNotes}
            invalidateKey={detailKey}
            placeholder="写下你对整篇内容的理解或疑问…"
          />
          {entry.sameCategory.length ? (
            <div className="card">
              <div className="card-title">同分类词条</div>
              <div className="chips">
                {entry.sameCategory.map((other) => (
                  <ConceptChip key={other.id} id={other.id} name={other.name} mastery={other.mastery} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {comparing ? <KbCompareDialog entry={entry} source={comparing} open onOpenChange={(open) => !open && setComparing(null)} /> : null}
      <KbDeleteDialog ids={[entry.id]} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={() => void navigate({ to: "/wiki" })} />
    </>
  );
}

function MasteryCard({ entry }: { entry: KbEntryDetail }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<number | null>(null);
  const shown = value ?? (entry.mastery === null ? null : Math.round(entry.mastery * 100));
  const setMastery = useMutation({
    mutationFn: (mastery: number | null) => api.patchKbEntry(entry.id, { mastery }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["kb", "entry", entry.id], updated);
      setValue(null);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["kb", "tree"] }), queryClient.invalidateQueries({ queryKey: ["kb", "graph"] })]);
    }
  });

  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => setMastery.mutate(value / 100), 400);
    return () => window.clearTimeout(timer);
  }, [value]);

  const current = shown === null ? null : shown / 100;
  return (
    <div className="card">
      <div className="card-title">
        掌握程度
        <span className="more" style={{ fontWeight: 600, color: masteryColor(current) }}>
          {masteryLabel(current)} {masteryPercent(current)}
        </span>
      </div>
      <input
        type="range"
        className="mastery-range"
        aria-label="掌握程度"
        min={0}
        max={100}
        value={shown ?? 0}
        style={{ accentColor: masteryColor(current) }}
        onChange={(event) => setValue(Number(event.target.value))}
      />
      <div className="small muted" style={{ marginTop: 6, lineHeight: 1.8 }}>
        {entry.masterySource === "user" ? (
          <>
            <span className="tag purple">你手动设定</span> 不再自动覆盖 ·{" "}
            <button type="button" className="link-btn" onClick={() => setMastery.mutate(null)}>
              恢复自动计算
            </button>
          </>
        ) : (
          <>自动估算：按来源数、阅读时长、问答次数与备注计算，整理与阅读后更新。拖动滑块可手动设定</>
        )}
      </div>
    </div>
  );
}

function EntryGraphCard({ entryId }: { entryId: string }) {
  const navigate = useNavigate();
  const graph = useQuery({ queryKey: ["kb", "graph"], queryFn: () => api.getKbGraph() });
  const ego = useMemo(() => (graph.data ? egoGraph(graph.data, entryId) : null), [graph.data, entryId]);
  const go = (id: string) => {
    if (id !== entryId) void navigate({ to: "/wiki/$entryId", params: { entryId: id } });
  };
  return (
    <div className="card">
      <div className="card-title">关联图谱{ego ? <span className="more muted">{ego.nodes.length - 1} 个词条</span> : null}</div>
      {ego?.edges.length ? (
        <div className="kb-entry-graph-canvas">
          <KbGraph graph={ego} checked={NO_IDS} relation="all" compact centerId={entryId} onToggle={go} onOpen={go} />
        </div>
      ) : (
        <div className="small faint">{graph.data ? "暂无关联词条" : "加载中…"}</div>
      )}
    </div>
  );
}

function KbToc({ activeId }: { activeId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { collapsed, toggleCollapsed } = useKbUiStore();
  const tree = useQuery({ queryKey: ["kb", "tree", "", ""], queryFn: () => api.getKbTree(), enabled: open });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="kb-toc" ref={ref}>
      <button type="button" className="btn kb-toc-btn" title="目录" aria-label="目录" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      </button>
      {open ? (
        <div className="card kb-toc-pop">
          {tree.data ? (
            <KbCategoryTree
              categories={tree.data.categories}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              onCheckMany={noop}
              activeId={activeId}
              checked={NO_CHECKED}
              onOpen={(id) => {
                setOpen(false);
                void navigate({ to: "/wiki/$entryId", params: { entryId: id } });
              }}
              onToggle={noop}
              onDelete={noop}
            />
          ) : (
            <div className="empty">加载中…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
