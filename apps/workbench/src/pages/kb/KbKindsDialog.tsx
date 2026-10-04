import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_KIND_LENGTH, type KbKindRename } from "@study-studio/shared";
import { api } from "@/api";
import { Modal } from "@/components/ui/Modal";
import { useUiStore } from "@/stores/ui";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed?: (from: string, to: string) => void;
};

/** Rename entry kinds; renaming to an existing kind merges into it (14 A6). */
export function KbKindsDialog({ open, onOpenChange, onRenamed }: Props) {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const kinds = useQuery({ queryKey: ["kb", "kinds"], queryFn: () => api.getKbKinds(), enabled: open });
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const rename = useMutation({
    mutationFn: (input: KbKindRename) => api.renameKbKind(input),
    onSuccess: async (_result, input) => {
      setEditing(null);
      onRenamed?.(input.from, input.to);
      await queryClient.invalidateQueries({ queryKey: ["kb"] });
    },
    onError: (error) => pushToast({ message: `改名失败：${error instanceof Error ? error.message : String(error)}` })
  });

  const all = kinds.data?.kinds ?? [];
  const to = value.trim();

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="管理类型">
      <div className="stack" style={{ gap: 8 }}>
        {kinds.isLoading ? <div className="small muted">加载中…</div> : null}
        {all
          .filter((kind) => kind.entryCount > 0)
          .map((kind) => {
            if (editing !== kind.name) {
              return (
                <div key={kind.name} className="row">
                  <span>{kind.name}</span>
                  <span className="small faint">{kind.entryCount} 个词条</span>
                  <div className="grow" />
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-label={`改名 ${kind.name}`}
                    onClick={() => {
                      setEditing(kind.name);
                      setValue(kind.name);
                    }}
                  >
                    改名
                  </button>
                </div>
              );
            }
            const target = to !== kind.name ? all.find((other) => other.name === to && other.entryCount > 0) : undefined;
            const submit = () => (to && to !== kind.name ? rename.mutate({ from: kind.name, to }) : setEditing(null));
            return (
              <div key={kind.name} className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <input
                    className="input grow"
                    aria-label={`新名称：${kind.name}`}
                    autoFocus
                    maxLength={MAX_KIND_LENGTH}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !target) submit();
                    }}
                  />
                  <button type="button" className="btn sm" onClick={() => setEditing(null)}>
                    取消
                  </button>
                  <button type="button" className="btn sm primary" disabled={!to || rename.isPending} onClick={submit}>
                    {target ? "确认合并" : "保存"}
                  </button>
                </div>
                {target ? (
                  <div className="small muted">
                    将合并到『{target.name}』，共 {target.entryCount + kind.entryCount} 个词条
                  </div>
                ) : null}
              </div>
            );
          })}
      </div>
    </Modal>
  );
}
