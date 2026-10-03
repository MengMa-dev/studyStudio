import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { OrganizeEvent, OrganizeRunStats } from "@study-studio/shared";
import { api } from "@/api";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";

const AFFECTED_QUERIES = [
  ["kb"],
  ["inbox"],
  ["item"],
  ["organize-runs"],
  ["organize-run"],
  ["organize-settings"],
  ["organize-preview"],
  ["overview"],
  ["home"],
  ["timeline"]
];

function finishedMessage(stats: OrganizeRunStats): string {
  const parts = [`入库 ${stats.items.ingested}`, `未采纳 ${stats.items.rejected}`];
  if (stats.items.failed) parts.push(`失败 ${stats.items.failed}`);
  const kb = stats.kb;
  const kbParts = [
    kb.entriesCreated ? `+${kb.entriesCreated} 知识点` : "",
    kb.entriesSupplemented ? `补充 ${kb.entriesSupplemented}` : "",
    kb.entriesRewritten ? `重写 ${kb.entriesRewritten}` : ""
  ].filter(Boolean);
  return `整理完成：${parts.join(" · ")}${kbParts.length ? `；知识库 ${kbParts.join(" · ")}` : ""}`;
}

/** Subscribes to organize events once per app (SSE in real mode, simulated in mock) and mirrors them into the store. */
export function OrganizeEventsBridge() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const { setActive, patchActive } = useOrganizeStore.getState();
    const { pushToast } = useUiStore.getState();
    const refresh = () => {
      for (const queryKey of AFFECTED_QUERIES) void queryClient.invalidateQueries({ queryKey });
    };
    const openRun = (runId: string) => () => void navigate({ to: "/runs/$runId", params: { runId } });

    void api
      .getOrganizeSettings()
      .then(async (settings) => {
        if (cancelled || !settings.activeRunId || useOrganizeStore.getState().active) return;
        const run = await api.getOrganizeRun(settings.activeRunId);
        if (cancelled || (run.status !== "running" && run.status !== "queued")) return;
        setActive({ runId: run.id, done: run.progress?.done ?? 0, total: run.progress?.total ?? 0, stage: run.progress?.stage ?? null, currentTitle: null });
      })
      .catch(() => undefined);

    const unsubscribe = api.subscribeOrganizeEvents((event: OrganizeEvent) => {
      switch (event.type) {
        case "run_started":
          setActive({ runId: event.runId, done: 0, total: event.total, stage: null, currentTitle: null });
          void queryClient.invalidateQueries({ queryKey: ["organize-runs"] });
          break;
        case "run_progress":
          patchActive(event.runId, { done: event.done, total: event.total, stage: event.stage, currentTitle: event.currentTitle });
          break;
        case "item_done":
          void queryClient.invalidateQueries({ queryKey: ["item", event.itemId] });
          break;
        case "run_finished":
          setActive(null);
          refresh();
          pushToast({ message: finishedMessage(event.stats), actionLabel: "查看记录", onAction: openRun(event.runId) });
          break;
        case "run_paused":
          setActive(null);
          refresh();
          pushToast({ message: "已达到每日 token 上限，剩余条目明天继续整理", actionLabel: "查看记录", onAction: openRun(event.runId) });
          break;
        case "run_failed":
          setActive(null);
          refresh();
          pushToast({ message: `整理失败：${event.error}`, actionLabel: "查看记录", onAction: openRun(event.runId) });
          break;
        case "heartbeat":
          break;
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [queryClient, navigate]);

  return null;
}
