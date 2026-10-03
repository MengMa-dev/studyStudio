import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { KbEntryKind, KbTreeCategoryNode, KbTreeEntryNode } from "@study-studio/shared";
import { api } from "@/api";
import { FILTER_KINDS, KIND_LABEL } from "@/lib/kb";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { KbDeleteDialog } from "./KbDeleteDialog";
import { KbPreviewPanel } from "./KbPreview";
import { categoryKey, KbCategoryTree, KbFlatList } from "./KbTree";

export type IndexedEntry = Omit<KbTreeEntryNode, "children"> & { categoryId: string | null; categoryName: string | null; parentId: string | null };

function indexTree(categories: KbTreeCategoryNode[]): IndexedEntry[] {
  const result: IndexedEntry[] = [];
  const walk = (nodes: KbTreeEntryNode[], category: KbTreeCategoryNode, parentId: string | null) => {
    for (const { children, ...node } of nodes) {
      result.push({ ...node, categoryId: category.id, categoryName: category.id ? category.name : null, parentId });
      walk(children, category, node.id);
    }
  };
  for (const category of categories) walk(category.children, category, null);
  return result;
}

type Props = {
  q: string;
  kind: KbEntryKind | undefined;
  selectedId: string | undefined;
  onFilterChange: (next: { q: string; kind: KbEntryKind | undefined }) => void;
};

export function KbPage({ q, kind, selectedId, onFilterChange }: Props) {
  const navigate = useNavigate();
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const { checked, collapsed, previewKey, toggleChecked, setChecked, clearChecked, toggleCollapsed, expand, setPreview } = useKbUiStore();
  const [text, setText] = useState(q);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const filtering = Boolean(q.trim()) || Boolean(kind);

  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const timer = window.setTimeout(() => onFilterChange({ q: text, kind }), 250);
    return () => window.clearTimeout(timer);
  }, [text, q, kind, onFilterChange]);

  const full = useQuery({ queryKey: ["kb", "tree", "", ""], queryFn: () => api.getKbTree() });
  const filtered = useQuery({
    queryKey: ["kb", "tree", q.trim(), kind ?? ""],
    enabled: filtering,
    queryFn: () => api.getKbTree({ q: q.trim() || undefined, kind })
  });

  const categories = useMemo(() => full.data?.categories ?? [], [full.data]);
  const entries = useMemo(() => indexTree(categories), [categories]);
  const entryIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
  const checkedIds = [...checked].filter((id) => entryIds.has(id));

  useEffect(() => {
    if (!selectedId) return;
    const target = entries.find((entry) => entry.id === selectedId);
    if (!target) return;
    expand(categoryKey(target.categoryId));
    setPreview(target.id);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-entry-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView?.({ block: "nearest" });
    });
  }, [selectedId, entries, expand, setPreview]);

  const effectivePreview = previewKey && (previewKey.startsWith("cat:") || entryIds.has(previewKey)) ? previewKey : (selectedId ?? null);

  const handlers = {
    activeId: selectedId ?? null,
    checked,
    onOpen: (id: string) => void navigate({ to: "/wiki/$entryId", params: { entryId: id } }),
    onToggle: toggleChecked,
    onHover: setPreview,
    onDelete: (id: string) => setDeleteIds([id])
  };

  const organizeChecked = () =>
    openOrganize({ scopes: checkedIds.length ? ["kb_selected", "kb_pending", "kb_all"] : ["kb_pending", "kb_all"], entryIds: checkedIds });

  const edgeCount = entries.filter((entry) => entry.parentId).length;
  const realCategories = categories.filter((category) => category.id !== null).length;

  return (
    <>
      <div className="page-header">
        <h1>知识库</h1>
        <span className="sub">
          {full.data ? `${full.data.total} 个词条 · ${realCategories} 个分类 · ${edgeCount} 条层级关系 · 由 AI 整理生成，可手动编辑` : "加载中…"}
        </span>
        <div className="actions">
          <button type="button" className="btn primary" data-organize-scope="kb" onClick={organizeChecked}>
            ✦ 整理
          </button>
        </div>
      </div>
      <div className="kb-layout">
        <div className="card kb-tree">
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" aria-label="搜索词条" placeholder="搜索词条或别名…" value={text} onChange={(event) => setText(event.target.value)} />
            <select
              className="input"
              aria-label="类型筛选"
              style={{ width: 104 }}
              value={kind ?? "all"}
              onChange={(event) => onFilterChange({ q: text, kind: event.target.value === "all" ? undefined : (event.target.value as KbEntryKind) })}
            >
              <option value="all">全部类型</option>
              {FILTER_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </div>
          <div className={`kb-toolbar ${checkedIds.length ? "active" : ""}`}>
            {checkedIds.length ? (
              <span>
                已选 <b>{checkedIds.length}</b> 项
              </span>
            ) : (
              <span className="small faint">{filtering ? `找到 ${filtered.data?.total ?? "…"} 个词条` : "勾选词条后可批量整理或删除"}</span>
            )}
            <div className="grow" />
            {checkedIds.length ? (
              <>
                <button type="button" className="btn sm" data-organize-scope="kb_selected" onClick={organizeChecked}>
                  ✦ 整理 {checkedIds.length}
                </button>
                <button type="button" className="btn sm danger" onClick={() => setDeleteIds(checkedIds)}>
                  删除 {checkedIds.length}
                </button>
                <button type="button" className="btn sm ghost" onClick={clearChecked}>
                  取消
                </button>
              </>
            ) : null}
          </div>
          {full.isLoading || (filtering && filtered.isLoading) ? <div className="empty">加载中…</div> : null}
          {full.isError ? <div className="empty">加载失败：{String(full.error)}</div> : null}
          {filtering && filtered.data ? (
            filtered.data.entries.length ? (
              <KbFlatList entries={filtered.data.entries} {...handlers} />
            ) : (
              <div className="empty">没有匹配的词条</div>
            )
          ) : null}
          {!filtering && full.data ? (
            categories.length ? (
              <KbCategoryTree categories={categories} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} onCheckMany={setChecked} {...handlers} />
            ) : (
              <div className="empty">知识库还是空的。整理收集箱后会自动生成词条</div>
            )
          ) : null}
        </div>
        <div className="stack kb-side">
          <KbPreviewPanel
            previewKey={effectivePreview}
            categories={categories}
            entries={entries}
            checkedIds={checkedIds}
            onOrganizeChecked={organizeChecked}
            onDeleteChecked={() => setDeleteIds(checkedIds)}
            onClearChecked={clearChecked}
            onDelete={(id) => setDeleteIds([id])}
          />
        </div>
      </div>
      <KbDeleteDialog
        ids={deleteIds ?? []}
        open={Boolean(deleteIds?.length)}
        onOpenChange={(open) => {
          if (!open) setDeleteIds(null);
        }}
        onDeleted={(ids) => {
          setChecked(ids, false);
          if (previewKey && ids.includes(previewKey)) setPreview(null);
        }}
      />
    </>
  );
}
