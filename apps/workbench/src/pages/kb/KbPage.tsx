import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { KbEntryKind, KbRelationType, KbTreeCategoryNode, KbTreeEntryNode } from "@study-studio/shared";
import { api } from "@/api";
import { EDGE_COLOR } from "@/lib/kb-graph";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { KbDeleteDialog } from "./KbDeleteDialog";
import { KbGraph } from "./KbGraph";
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

const RELATIONS: [KbRelationType | "all", string][] = [
  ["all", "全部"],
  ["part_of", "属于"],
  ["prerequisite", "前置"],
  ["related", "相关"],
  ["contrasts", "对比"]
];

type Props = {
  q: string;
  kind: KbEntryKind | undefined;
  selectedId: string | undefined;
  onFilterChange: (next: { q: string; kind: KbEntryKind | undefined }) => void;
};

export function KbPage({ q, kind, selectedId, onFilterChange }: Props) {
  const navigate = useNavigate();
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const { checked, collapsed, graphRelation, toggleChecked, setChecked, clearChecked, toggleCollapsed, expand, setGraphRelation } = useKbUiStore();
  const [text, setText] = useState(q);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const kinds = useQuery({ queryKey: ["kb", "kinds"], queryFn: () => api.getKbKinds() });
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
  const graph = useQuery({ queryKey: ["kb", "graph"], queryFn: () => api.getKbGraph() });

  const categories = useMemo(() => full.data?.categories ?? [], [full.data]);
  const entries = useMemo(() => indexTree(categories), [categories]);
  const entryIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
  const checkedIds = [...checked].filter((id) => entryIds.has(id));

  const revealInTree = useCallback(
    (id: string) => {
      const target = entries.find((entry) => entry.id === id);
      if (!target) return;
      expand(categoryKey(target.categoryId));
      window.requestAnimationFrame(() => {
        document.querySelector(`[data-entry-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: "nearest" });
      });
    },
    [entries, expand]
  );

  useEffect(() => {
    if (selectedId) revealInTree(selectedId);
  }, [selectedId, revealInTree]);

  const checkedKey = checkedIds.join("\n");
  const graphChecked = useMemo(() => (checkedKey ? checkedKey.split("\n") : []), [checkedKey]);

  const handlers = {
    activeId: selectedId ?? null,
    checked,
    onOpen: (id: string) => void navigate({ to: "/wiki/$entryId", params: { entryId: id } }),
    onToggle: toggleChecked,
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
          <div className="kb-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input aria-label="搜索词条" placeholder="搜索词条或别名…" value={text} onChange={(event) => setText(event.target.value)} />
            <select
              aria-label="类型筛选"
              value={kind ?? ""}
              onChange={(event) => onFilterChange({ q: text, kind: event.target.value || undefined })}
            >
              <option value="">全部类型</option>
              {kind && !kinds.data?.kinds.some((option) => option.name === kind) ? <option value={kind}>{kind}（0）</option> : null}
              {kinds.data?.kinds
                .filter((option) => option.seed || option.entryCount > 0)
                .map((option) => (
                  <option key={option.name} value={option.name}>
                    {option.name}（{option.entryCount}）
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
              <span className="small faint">
                {filtering ? `找到 ${filtered.data?.total ?? "…"} 个词条` : `${full.data?.total ?? "…"} 个词条 · 勾选后可批量整理或删除`}
              </span>
            )}
            <div className="grow" />
            {checkedIds.length ? (
              <>
                <button type="button" className="btn sm" data-organize-scope="kb_selected" onClick={organizeChecked}>
                  ✦ 整理
                </button>
                <button type="button" className="btn sm danger" onClick={() => setDeleteIds(checkedIds)}>
                  删除
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
        <div className="stack">
          <div className="kb-graph-wrap">
            <div className="kb-graph-filter" role="group" aria-label="关系筛选">
              {RELATIONS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={graphRelation === value} onClick={() => setGraphRelation(value)}>
                  {value === "all" ? null : <i style={{ borderColor: EDGE_COLOR[value], borderTopStyle: value === "contrasts" ? "dashed" : "solid" }} />}
                  {label}
                </button>
              ))}
            </div>
            {graph.isError ? <div className="empty">图谱加载失败：{String(graph.error)}</div> : null}
            {graph.data && !graph.data.nodes.length ? <div className="empty">知识库还是空的</div> : null}
            {graph.data?.nodes.length ? (
              <KbGraph
                graph={graph.data}
                checked={graphChecked}
                relation={graphRelation}
                onToggle={(id) => {
                  const willCheck = !checked.has(id);
                  toggleChecked(id);
                  if (willCheck) revealInTree(id);
                }}
                onOpen={handlers.onOpen}
              />
            ) : null}
          </div>
        </div>
      </div>
      <KbDeleteDialog
        ids={deleteIds ?? []}
        open={Boolean(deleteIds?.length)}
        onOpenChange={(open) => {
          if (!open) setDeleteIds(null);
        }}
        onDeleted={(ids) => setChecked(ids, false)}
      />
    </>
  );
}
