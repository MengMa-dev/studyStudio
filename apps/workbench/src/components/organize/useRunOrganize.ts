import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OrganizeRunRequestInput } from "@study-studio/shared";
import { api } from "@/api";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";

export function isRunConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("run_in_progress");
}

/** Starts a manual run and hands progress to the sidebar indicator (dialog and chat card share this). */
export function useRunOrganize({ onStarted }: { onStarted?: () => void } = {}) {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const setActive = useOrganizeStore((state) => state.setActive);

  return useMutation({
    mutationFn: (body: OrganizeRunRequestInput) => api.runOrganize(body),
    onSuccess: async ({ run: started }) => {
      onStarted?.();
      const current = useOrganizeStore.getState().active;
      if (!current || current.runId !== started.id) {
        setActive({
          runId: started.id,
          done: started.progress?.done ?? 0,
          total: started.progress?.total ?? 0,
          stage: started.progress?.stage ?? null,
          currentTitle: null
        });
      }
      pushToast({ message: "已开始整理，进度见侧栏" });
      await queryClient.invalidateQueries({ queryKey: ["organize-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["organize-settings"] });
    },
    onError: (error) => {
      pushToast({ message: isRunConflict(error) ? "已有整理在进行，完成后再试" : `发起整理失败：${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
