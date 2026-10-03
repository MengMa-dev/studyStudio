import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Checkbox } from "radix-ui";
import type { InboxListRow, InboxListStatusFilter, InboxListTypeFilter } from "@study-studio/shared";
import { api } from "@/api";
import { InboxOrganizeHint } from "@/components/organize/InboxOrganizeHint";
import { EllipsisText } from "@/components/ui/EllipsisText";
import { Modal } from "@/components/ui/Modal";
import { formatCapturedAt, fmtDuration, organizeStatusLabel, readStatusLabel, siteShort } from "@/lib/format";
import { pageSelectionStats, partitionSelection } from "@/lib/selection";
import { useOrganizeStore } from "@/stores/organize";
import { useSelectionStore } from "@/stores/selection";
import { useUiStore } from "@/stores/ui";
import styles from "./InboxPage.module.css";

const TABS: Array<{ id: InboxListTypeFilter | "trash"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "webpage", label: "网页" },
  { id: "conversation", label: "问答" },
  { id: "trash", label: "回收站" }
];

const STATUSES: Array<{ id: InboxListStatusFilter; label: string }> = [
  { id: "all", label: "全部状态" },
  { id: "unread", label: "未读" },
  { id: "read", label: "已读" },
  { id: "pending", label: "待整理" },
  { id: "ingested", label: "已入库" },
  { id: "rejected", label: "未采纳" }
];

type Props = {
  type: InboxListTypeFilter | "trash";
  status: InboxListStatusFilter;
  onTypeChange: (type: InboxListTypeFilter | "trash") => void;
  onStatusChange: (status: InboxListStatusFilter) => void;
};

export function InboxPage({ type, status, onTypeChange, onStatusChange }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const selected = useSelectionStore((state) => state.selected);
  const toggle = useSelectionStore((state) => state.toggle);
  const selectAllPage = useSelectionStore((state) => state.selectAllPage);
  const clear = useSelectionStore((state) => state.clear);
  const pushToast = useUiStore((state) => state.pushToast);
  const openOrganize = useOrganizeStore((state) => state.openDialog);

  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [limit, setLimit] = useState(50);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagText, setTagText] = useState("");
  const [removeFromKb, setRemoveFromKb] = useState(true);
  const [rule, setRule] = useState<"none" | "url" | "domain">("none");

  const cursor = cursorStack[pageIndex];

  const list = useQuery({
    queryKey: ["inbox", type, status, cursor, limit],
    enabled: type !== "trash",
    queryFn: () =>
      api.getInboxList({
        type: type === "trash" ? "all" : type,
        status,
        cursor,
        limit
      })
  });

  const trash = useQuery({
    queryKey: ["trash"],
    enabled: type === "trash",
    queryFn: () => api.listTrash()
  });

  const pageRows = list.data?.rows ?? [];
  const pageIds = pageRows.map((row) => row.id);
  const stats = pageSelectionStats(selected, pageIds);

  const allItemIdsQuery = useQuery({
    queryKey: ["inbox-all-ids"],
    queryFn: async () => {
      const first = await api.getInboxList({ type: "all", status: "all", limit: 100 });
      return first.rows.filter((row) => row.kind === "item").map((row) => row.id);
    }
  });

  const impactIds = useMemo(() => {
    const { itemIds, noteIds } = partitionSelection(
      selected,
      allItemIdsQuery.data ?? pageIds.filter((id) => pageRows.find((row) => row.id === id && row.kind === "item"))
    );
    return { itemIds, noteIds };
  }, [selected, allItemIdsQuery.data, pageIds, pageRows]);

  const impact = useQuery({
    queryKey: ["impact", impactIds.itemIds.join(","), impactIds.noteIds.join(",")],
    enabled: deleteOpen && (impactIds.itemIds.length > 0 || impactIds.noteIds.length > 0),
    queryFn: () => api.getDeleteImpact(impactIds.itemIds, impactIds.noteIds)
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["inbox"] });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
    await queryClient.invalidateQueries({ queryKey: ["overview"] });
    await queryClient.invalidateQueries({ queryKey: ["home"] });
    await queryClient.invalidateQueries({ queryKey: ["timeline"] });
  };

  const bulkRead = useMutation({
    mutationFn: () => api.bulkInbox({ action: "read_status", ids: impactIds.itemIds, readStatus: "read" }),
    onSuccess: async () => {
      await invalidate();
      pushToast({ message: `已标记 ${impactIds.itemIds.length} 条为已读` });
    }
  });

  const bulkTags = useMutation({
    mutationFn: (tags: string[]) => api.bulkInbox({ action: "tags", ids: impactIds.itemIds, tags, mode: "add" }),
    onSuccess: async () => {
      await invalidate();
      setTagOpen(false);
      setTagText("");
      pushToast({ message: "已添加标签" });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.deleteItems({
        ids: impactIds.itemIds,
        noteIds: impactIds.noteIds,
        removeFromKb,
        rule
      }),
    onSuccess: async (result) => {
      clear();
      setDeleteOpen(false);
      await invalidate();
      pushToast({
        message: `已移入回收站（${result.deletedItemCount + result.deletedNoteCount} 项）`,
        actionLabel: "撤销",
        onAction: () => {
          void api.restoreTrash(result.trashId).then(async () => {
            await invalidate();
            pushToast({ message: "已撤销删除" });
          });
        }
      });
    }
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTrash(id),
    onSuccess: async () => {
      await invalidate();
      pushToast({ message: "已恢复" });
    }
  });

  const purge = useMutation({
    mutationFn: (id: string) => api.purgeTrash(id),
    onSuccess: async () => {
      await invalidate();
      pushToast({ message: "已彻底删除" });
    }
  });

  const resetPaging = () => {
    setCursorStack([undefined]);
    setPageIndex(0);
  };

  return (
    <>
      <div className="page-header">
        <h1>收集箱</h1>
        <span className="sub">共 {list.data?.total ?? trash.data?.entries.length ?? "—"} 条</span>
        <div className="actions">
          <button
            type="button"
            className="btn"
            data-organize-scope="inbox"
            onClick={() =>
              openOrganize({
                scopes: impactIds.itemIds.length ? ["inbox_selected", "inbox_pending", "inbox_all"] : ["inbox_pending", "inbox_all"],
                itemIds: impactIds.itemIds
              })
            }
          >
            ✦ 整理
          </button>
        </div>
      </div>
      {type === "trash" ? null : <InboxOrganizeHint selectedItemIds={impactIds.itemIds} />}
      <div className={`card inbox-card ${styles.card}`}>
        <div className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`tab ${type === tab.id ? "active" : ""}`}
              onClick={() => {
                onTypeChange(tab.id);
                resetPaging();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {type === "trash" ? (
          <div className="inbox-scroll">
            {!trash.data?.entries.length ? (
              <div className="empty">回收站是空的。删除的内容会在这里保留 30 天，可撤销</div>
            ) : (
              trash.data.entries.map((entry) => (
                <div key={entry.id} className="list-item" style={{ cursor: "default" }}>
                  <div className="grow">
                    <div className="title">{entry.title}</div>
                    <div className="meta">
                      <span>{formatCapturedAt(entry.deletedAt)} 删除</span>
                      <span>{entry.removeFromKb ? `知识库已同步移除 · ${entry.removedEntryCount} 个知识点` : "知识库内容已保留"}</span>
                    </div>
                  </div>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => restore.mutate(entry.id)}>
                      撤销删除
                    </button>
                    <button type="button" className="btn sm danger" onClick={() => purge.mutate(entry.id)}>
                      彻底删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <label className="select-all">
                <Checkbox.Root
                  className={styles.checkbox}
                  checked={stats.allChecked ? true : stats.partial ? "indeterminate" : false}
                  disabled={!pageIds.length}
                  onCheckedChange={(value) => selectAllPage(pageIds, value === true)}
                >
                  <Checkbox.Indicator className={styles.indicator}>✓</Checkbox.Indicator>
                </Checkbox.Root>
                全选
              </label>
              <div className="chips">
                {STATUSES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`chip ${status === entry.id ? "active" : ""}`}
                    onClick={() => {
                      onStatusChange(entry.id);
                      resetPaging();
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>

            {selected.size > 0 ? (
              <div className="batch-bar">
                已选 {selected.size} 项
                {stats.hidden ? (
                  <span className="small" style={{ opacity: 0.75 }}>
                    （{stats.hidden} 项不在当前页）
                  </span>
                ) : null}
                <div className="grow" />
                {impactIds.itemIds.length ? (
                  <button type="button" className="btn sm" onClick={() => bulkRead.mutate()}>
                    标为已读
                  </button>
                ) : null}
                {impactIds.itemIds.length ? (
                  <button type="button" className="btn sm" onClick={() => setTagOpen(true)}>
                    加标签
                  </button>
                ) : null}
                {impactIds.itemIds.length ? (
                  <button
                    type="button"
                    className="btn sm"
                    data-organize-scope="inbox_selected"
                    onClick={() => openOrganize({ scopes: ["inbox_selected", "inbox_pending", "inbox_all"], itemIds: impactIds.itemIds })}
                  >
                    ✦ 整理
                  </button>
                ) : null}
                <button type="button" className="btn sm danger" onClick={() => setDeleteOpen(true)}>
                  删除
                </button>
                <button type="button" className="btn sm ghost" onClick={() => clear()}>
                  取消
                </button>
              </div>
            ) : null}

            <div className="inbox-scroll">
              {list.isLoading ? <div className="empty">加载中…</div> : null}
              {!list.isLoading && !pageRows.length ? <div className="empty">没有符合条件的内容</div> : null}
              {pageRows.map((row) => (
                <InboxRow
                  key={row.id}
                  row={row}
                  checked={selected.has(row.id)}
                  onToggle={() => toggle(row.id)}
                  onOpen={() => {
                    if (row.kind === "item") void navigate({ to: "/item/$itemId", params: { itemId: row.id } });
                  }}
                />
              ))}
            </div>

            <div className="pager">
              <span className="small muted">共 {list.data?.total ?? 0} 条</span>
              <div className="grow" />
              <select
                className="input"
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  resetPaging();
                }}
              >
                {[20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size} 条/页
                  </option>
                ))}
              </select>
              <button type="button" className="pg" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => Math.max(0, value - 1))}>
                ‹
              </button>
              <span className="small muted">第 {pageIndex + 1} 页</span>
              <button
                type="button"
                className="pg"
                disabled={!list.data?.nextCursor}
                onClick={() => {
                  if (!list.data?.nextCursor) return;
                  setCursorStack((stack) => {
                    const next = stack.slice(0, pageIndex + 1);
                    next.push(list.data.nextCursor ?? undefined);
                    return next;
                  });
                  setPageIndex((value) => value + 1);
                }}
              >
                ›
              </button>
            </div>
          </>
        )}
      </div>

      <Modal open={deleteOpen} onOpenChange={setDeleteOpen} title="删除选中内容？">
        <div className="stack" style={{ gap: 10 }}>
          <div>
            将删除 {impactIds.itemIds.length} 条条目
            {impactIds.noteIds.length ? `、${impactIds.noteIds.length} 条备注` : ""}。
          </div>
          {impact.data ? (
            <div className="small muted">
              影响预览：删除知识点 {impact.data.entriesToDelete.length} · 置 stale {impact.data.entriesToStale.length} · evidence {impact.data.evidenceCount}
            </div>
          ) : null}
          <label className="row">
            <input type="checkbox" checked={removeFromKb} onChange={(event) => setRemoveFromKb(event.target.checked)} />
            同时从知识库移除
          </label>
          <label className="field">
            排除规则
            <select className="input" value={rule} onChange={(event) => setRule(event.target.value as typeof rule)}>
              <option value="none">仅删除</option>
              <option value="url">不再收集此页面</option>
              <option value="domain">不再收集该网站</option>
            </select>
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setDeleteOpen(false)}>
              取消
            </button>
            <button type="button" className="btn primary danger-fill" onClick={() => deleteMutation.mutate()}>
              删除
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={tagOpen} onOpenChange={setTagOpen} title="批量添加标签">
        <div className="stack" style={{ gap: 10 }}>
          <input className="input" value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用逗号分隔多个标签" />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setTagOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const tags = tagText
                  .split(/[,，]/)
                  .map((tag) => tag.trim())
                  .filter(Boolean);
                if (tags.length) bulkTags.mutate(tags);
              }}
            >
              添加
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function InboxRow({ row, checked, onToggle, onOpen }: { row: InboxListRow; checked: boolean; onToggle: () => void; onOpen: () => void }) {
  if (row.kind === "fuzzy_note") {
    return (
      <div className="list-item note-item" style={{ cursor: "default" }}>
        <label className="check-hit" onClick={(event) => event.stopPropagation()}>
          <Checkbox.Root className={styles.checkbox} checked={checked} onCheckedChange={() => onToggle()}>
            <Checkbox.Indicator className={styles.indicator}>✓</Checkbox.Indicator>
          </Checkbox.Root>
        </label>
        <span className="note-icon">✎</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="title-row">
            <EllipsisText text={row.text} className="title" />
            <span className="tag teal">模糊备注</span>
          </div>
          <div className="meta">
            <span>{row.origin}</span>
            <span>整理时作为意图信号</span>
          </div>
        </div>
        <div className="right-meta">
          <span>{formatCapturedAt(row.createdAt)}</span>
        </div>
      </div>
    );
  }

  const read = readStatusLabel(row.readStatus);
  const organize = organizeStatusLabel(row.organizeStatus);
  const icon = siteShort(row.site);

  return (
    <div className="list-item" onClick={onOpen}>
      <label className="check-hit" onClick={(event) => event.stopPropagation()}>
        <Checkbox.Root className={styles.checkbox} checked={checked} onCheckedChange={() => onToggle()}>
          <Checkbox.Indicator className={styles.indicator}>✓</Checkbox.Indicator>
        </Checkbox.Root>
      </label>
      <div className="src-icon" style={{ background: icon.color }}>
        {icon.short}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title-row">
          <EllipsisText text={row.title} className="title" />
          <span className={`tag ${read.tone}`}>{read.label}</span>
          <span className={`tag ${organize.tone}`}>{organize.label}</span>
        </div>
        <div className="meta">
          <span>{row.site}</span>
          <span>{row.type === "conversation" ? "问答" : "网页"}</span>
          {row.readingTotalSeconds ? <span>{fmtDuration(row.readingTotalSeconds)}</span> : null}
          {row.tags.map((tag) => (
            <span key={tag} className="tag">
              #{tag}
            </span>
          ))}
        </div>
      </div>
      <div className="right-meta">
        <span>{formatCapturedAt(row.capturedAt)}</span>
        <Link to="/item/$itemId" params={{ itemId: row.id }} className="faint" onClick={(event) => event.stopPropagation()}>
          →
        </Link>
      </div>
    </div>
  );
}
