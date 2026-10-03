import type { KbFlatEntry, KbTreeCategoryNode, KbTreeEntryNode } from "@study-studio/shared";
import { EllipsisText } from "@/components/ui/EllipsisText";
import { masteryColor, masteryPercent } from "@/lib/kb";

export function categoryKey(id: string | null): string {
  return `cat:${id ?? "none"}`;
}

export function collectIds(nodes: KbTreeEntryNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectIds(node.children)]);
}

type RowEntry = Pick<KbTreeEntryNode, "id" | "name" | "mastery" | "stale" | "userEdited" | "orphan" | "sourceCount">;

type RowHandlers = {
  activeId: string | null;
  checked: Set<string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onHover: (key: string) => void;
  onDelete: (id: string) => void;
};

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
    </svg>
  );
}

function EntryRow({ entry, depth, extra, handlers }: { entry: RowEntry; depth: number; extra?: string | null; handlers: RowHandlers }) {
  const checked = handlers.checked.has(entry.id);
  const classes = ["tree-row", handlers.activeId === entry.id ? "active" : "", checked ? "checked" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="treeitem"
      aria-selected={handlers.activeId === entry.id}
      data-entry-id={entry.id}
      data-depth={depth}
      style={{ paddingLeft: 12 + depth * 18 }}
      onClick={() => handlers.onOpen(entry.id)}
      onMouseEnter={() => handlers.onHover(entry.id)}
      onFocus={() => handlers.onHover(entry.id)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") handlers.onOpen(entry.id);
      }}
    >
      <input
        type="checkbox"
        aria-label={`选择 ${entry.name}`}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={() => handlers.onToggle(entry.id)}
      />
      <i className="tree-dot" style={{ background: masteryColor(entry.mastery) }} />
      <span className="grow">
        <EllipsisText text={entry.name} />
      </span>
      {extra ? <span className="small faint kb-row-cat">{extra}</span> : null}
      {entry.stale ? (
        <span className="tag orange" title="来源有变化，下次整理更新">
          ↻
        </span>
      ) : null}
      {entry.userEdited ? (
        <span className="tag purple" title="手动编辑过">
          ✎
        </span>
      ) : null}
      {entry.orphan ? (
        <span className="tag red" title="没有存活的来源">
          无来源
        </span>
      ) : null}
      <span className="small faint pct">{masteryPercent(entry.mastery)}</span>
      <button
        type="button"
        className="btn sm ghost icon-btn tree-del"
        title="删除知识点"
        aria-label={`删除 ${entry.name}`}
        onClick={(event) => {
          event.stopPropagation();
          handlers.onDelete(entry.id);
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function Branch({ node, depth, handlers }: { node: KbTreeEntryNode; depth: number; handlers: RowHandlers }) {
  return (
    <>
      <EntryRow entry={node} depth={depth} handlers={handlers} />
      {node.children.map((child) => (
        <Branch key={child.id} node={child} depth={depth + 1} handlers={handlers} />
      ))}
    </>
  );
}

type TreeProps = RowHandlers & {
  categories: KbTreeCategoryNode[];
  collapsed: Set<string>;
  onToggleCollapsed: (key: string) => void;
  onCheckMany: (ids: string[], checked: boolean) => void;
};

export function KbCategoryTree({ categories, collapsed, onToggleCollapsed, onCheckMany, ...handlers }: TreeProps) {
  return (
    <div className="tree" role="tree" aria-label="知识库目录">
      {categories.map((category) => {
        const key = categoryKey(category.id);
        const isCollapsed = collapsed.has(key);
        const ids = collectIds(category.children);
        const checkedCount = ids.filter((id) => handlers.checked.has(id)).length;
        return (
          <div key={key} role="group">
            <div
              className="tree-cat"
              data-category-key={key}
              title={isCollapsed ? "展开" : "折叠"}
              onClick={() => onToggleCollapsed(key)}
              onMouseEnter={() => handlers.onHover(key)}
            >
              <input
                type="checkbox"
                aria-label={`选中分类 ${category.name} 下全部词条`}
                checked={ids.length > 0 && checkedCount === ids.length}
                ref={(element) => {
                  if (element) element.indeterminate = checkedCount > 0 && checkedCount < ids.length;
                }}
                disabled={!ids.length}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onCheckMany(ids, event.target.checked)}
              />
              <span className="caret">{isCollapsed ? "▸" : "▾"}</span>
              <span className="grow">{category.name}</span>
              <span className="small faint">
                {category.entryCount} · {masteryPercent(category.avgMastery)}
              </span>
            </div>
            {isCollapsed ? null : category.children.map((node) => <Branch key={node.id} node={node} depth={1} handlers={handlers} />)}
          </div>
        );
      })}
    </div>
  );
}

export function KbFlatList({ entries, ...handlers }: RowHandlers & { entries: KbFlatEntry[] }) {
  return (
    <div className="tree" role="tree" aria-label="搜索结果">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} depth={0} extra={entry.categoryName ?? "未归类"} handlers={handlers} />
      ))}
    </div>
  );
}
