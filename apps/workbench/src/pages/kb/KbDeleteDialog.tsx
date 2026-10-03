import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { Modal } from "@/components/ui/Modal";
import { useUiStore } from "@/stores/ui";

type Props = {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (deletedIds: string[]) => void;
};

const KB_QUERIES = [["kb"], ["trash"], ["inbox"], ["item"]];

/** Delete preview + confirm (08 删除): notes and relations go, children move up, sources stay in the inbox. */
export function KbDeleteDialog({ ids, open, onOpenChange, onDeleted }: Props) {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const [ignore, setIgnore] = useState(true);

  const impact = useQuery({
    queryKey: ["kb", "impact", ids.join(",")],
    enabled: open && ids.length > 0,
    queryFn: () => api.getKbDeleteImpact(ids),
    staleTime: 0
  });

  const refresh = async () => {
    for (const queryKey of KB_QUERIES) await queryClient.invalidateQueries({ queryKey });
  };

  const remove = useMutation({
    mutationFn: (input: { ids: string[]; ignore: boolean }) => api.deleteKbEntries(input),
    onSuccess: async (result, input) => {
      onOpenChange(false);
      onDeleted?.(input.ids);
      const names = impact.data?.entries ?? [];
      pushToast({
        message: `已删除${names.length === 1 ? `「${names[0]?.name}」` : ` ${result.deletedEntryCount} 个知识点`}${input.ignore ? "，并加入整理忽略列表" : ""}`,
        actionLabel: "撤销",
        onAction: () => {
          void api.restoreTrash(result.trashId).then(async () => {
            await refresh();
            pushToast({ message: "已撤销删除" });
          });
        }
      });
      await refresh();
    },
    onError: (error) => pushToast({ message: `删除失败：${error instanceof Error ? error.message : String(error)}` })
  });

  const data = impact.data;
  const single = ids.length === 1;
  const title = single ? `删除知识点「${data?.entries[0]?.name ?? "…"}」？` : `删除 ${ids.length} 个知识点？`;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="stack" style={{ gap: 12 }}>
        {!single && data ? (
          <div className="chips">
            {data.entries.map((entry) => (
              <span key={entry.id} className="chip">
                {entry.name}
              </span>
            ))}
          </div>
        ) : null}
        {impact.isLoading ? <div className="small muted">正在计算影响…</div> : null}
        {data ? (
          <div className="stack small" style={{ gap: 6 }} data-testid="kb-delete-impact">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span>🗑</span>
              <span>
                删除词条正文、{data.noteCount} 条知识点备注与 {data.relationCount} 条关系
              </span>
            </div>
            {data.reparentedChildren.length ? (
              <div className="row" style={{ alignItems: "flex-start" }}>
                <span>↑</span>
                <span>
                  {data.reparentedChildren.map((child, index) => (
                    <span key={child.id}>
                      {index ? "；" : ""}
                      <b>{child.name}</b> 移到{child.newParentName ? `「${child.newParentName}」下` : "分类根目录"}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span>✓</span>
              <span>{data.sourceItemCount} 条来源学习记录保留在收集箱，不受影响</span>
            </div>
            <div className="faint">删除进入回收站，30 天内可撤销</div>
          </div>
        ) : null}
        <label className="row small">
          <input type="checkbox" checked={ignore} onChange={(event) => setIgnore(event.target.checked)} />
          以后整理时不再自动生成{single ? "这个" : "这些"}知识点
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button type="button" className="btn primary danger-fill" disabled={!data || remove.isPending} onClick={() => remove.mutate({ ids, ignore })}>
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}
