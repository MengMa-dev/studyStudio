import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatProfileCardData } from "@study-studio/shared";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";

export function ProfileRecordedCard({ data }: { data: ChatProfileCardData }) {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["home"] });
    void queryClient.invalidateQueries({ queryKey: ["learner-profile"] });
  }, [queryClient]);
  const undo = useMutation({
    mutationFn: () => api.putLearnerProfile(data.previous),
    onSuccess: () => {
      setUndone(true);
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["learner-profile"] });
      pushToast({ message: "已撤销档案记录" });
    },
    onError: (error) => pushToast({ message: `撤销失败：${error instanceof Error ? error.message : String(error)}` })
  });

  return (
    <div className="chat-card" aria-label="学习者档案记录">
      <div className="chat-card-title">{undone ? "已撤销记录" : "✓ 已记录到学习者档案"}</div>
      <div className="chat-card-meta small">
        {data.role ? (
          <>
            <span className="muted">角色</span>
            <span className={undone ? "chat-struck" : ""}>{data.role}</span>
          </>
        ) : null}
        {data.direction ? (
          <>
            <span className="muted">学习方向</span>
            <span className={undone ? "chat-struck" : ""}>{data.direction}</span>
          </>
        ) : null}
      </div>
      {undone ? null : (
        <div className="row">
          <button type="button" className="btn sm" disabled={undo.isPending} onClick={() => undo.mutate()}>
            撤销
          </button>
          <span className="small faint">也可以在设置的「学习者档案」中修改</span>
        </div>
      )}
    </div>
  );
}
