import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OrganizeRunSummary } from "@study-studio/shared";
import { api } from "@/api";
import { isRunConflict } from "@/components/organize/OrganizeDialog";
import { DECISION_LABEL, formatDateTime, formatElapsed, formatTokens, RUN_STATUS, SCOPE_LABEL, STAGE_LABEL, TRIGGER_LABEL } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";

export function useRetryRun() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const setActive = useOrganizeStore((state) => state.setActive);
  return useMutation({
    mutationFn: (runId: string) => api.retryOrganizeRun(runId),
    onSuccess: async ({ run }) => {
      if (useOrganizeStore.getState().active?.runId !== run.id) {
        setActive({ runId: run.id, done: run.progress?.done ?? 0, total: run.progress?.total ?? 0, stage: run.progress?.stage ?? null, currentTitle: null });
      }
      pushToast({ message: "已重新排队失败项，进度见侧栏" });
      await queryClient.invalidateQueries({ queryKey: ["organize-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["organize-run"] });
    },
    onError: (error) =>
      pushToast({ message: isRunConflict(error) ? "已有整理在进行，完成后再试" : `重试失败：${error instanceof Error ? error.message : String(error)}` })
  });
}

export function kbChangeText(run: OrganizeRunSummary): string {
  const kb = run.stats.kb;
  const parts = [
    kb.entriesCreated ? `+${kb.entriesCreated} 知识点` : "",
    kb.relationsCreated ? `+${kb.relationsCreated} 关系` : "",
    kb.entriesSupplemented ? `补充 ${kb.entriesSupplemented} 个` : "",
    kb.entriesRewritten ? `重写 ${kb.entriesRewritten} 个` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "无变化";
}

export function episodeText(run: OrganizeRunSummary): string {
  const e = run.stats.episodes;
  return e.learning + e.notLearning + e.deferred ? `学习 ${e.learning} · 非学习 ${e.notLearning}${e.deferred ? ` · 推迟 ${e.deferred}` : ""}` : "未切分";
}

export function RunStatusTags({ run }: { run: OrganizeRunSummary }) {
  const status = RUN_STATUS[run.status];
  return (
    <>
      <span className="tag">{TRIGGER_LABEL[run.trigger]}</span>
      {run.scope ? <span className="tag">{SCOPE_LABEL[run.scope]}</span> : null}
      {run.status !== "completed" ? <span className={`tag ${status.tone}`}>{status.label}</span> : null}
      {run.stats.items.failed ? <span className="tag red">失败 {run.stats.items.failed}</span> : null}
    </>
  );
}

export function RunProgress({ run }: { run: OrganizeRunSummary }) {
  if (!run.progress || (run.status !== "running" && run.status !== "queued" && run.status !== "paused")) return null;
  const { done, total, stage } = run.progress;
  return (
    <div>
      <div className="row small muted">
        {stage ? STAGE_LABEL[stage] : "准备中"}
        <div className="grow" />
        {done}/{total}
      </div>
      <div className="progress">
        <div style={{ width: `${total ? (done / total) * 100 : 0}%`, background: "var(--purple)" }} />
      </div>
    </div>
  );
}

export function RunCard({ run }: { run: OrganizeRunSummary }) {
  const retry = useRetryRun();
  const elapsed = formatElapsed(run.startedAt, run.finishedAt);
  const stats = run.stats;
  return (
    <div className="card run-card" data-testid="run-card">
      <div className="row wrap">
        <Link to="/runs/$runId" params={{ runId: run.id }}>
          <b>{formatDateTime(run.startedAt)}</b>
        </Link>
        <RunStatusTags run={run} />
        {elapsed ? <span className="small faint">耗时 {elapsed}</span> : null}
        <div className="grow" />
        {stats.items.failed ? (
          <button type="button" className="btn sm" disabled={retry.isPending} onClick={() => retry.mutate(run.id)}>
            重试失败项
          </button>
        ) : null}
        <Link to="/runs/$runId" params={{ runId: run.id }} className="btn sm ghost">
          详情 →
        </Link>
      </div>
      {run.requirement ? <div className="small muted">整理要求：{run.requirement}</div> : null}
      <RunProgress run={run} />
      <div className="run-stats">
        <div>
          <div className="small muted">处理条目</div>
          <b>{stats.items.total}</b>
        </div>
        <div>
          <div className="small muted">活动片段</div>
          <b className="small-b">{episodeText(run)}</b>
        </div>
        <div>
          <div className="small muted">已入库</div>
          <b style={{ color: "var(--green)" }}>{stats.items.ingested}</b>
        </div>
        <div>
          <div className="small muted">未采纳</div>
          <b style={{ color: "var(--orange)" }}>{stats.items.rejected}</b>
        </div>
        <div>
          <div className="small muted">知识库变化</div>
          <b className="small-b">{kbChangeText(run)}</b>
        </div>
      </div>
      <div className="chips">
        {DECISION_LABEL.filter((decision) => stats.decisions[decision.key]).map((decision) => (
          <span key={decision.key} className={`tag ${decision.tone}`}>
            {decision.label} {stats.decisions[decision.key]}
          </span>
        ))}
        {stats.decisions.prefiltered ? <span className="tag">规则预过滤 {stats.decisions.prefiltered}</span> : null}
      </div>
      {stats.stages.length ? (
        <details className="run-steps">
          <summary className="small muted">
            各阶段消耗 · {formatTokens(run.tokens)} tokens{run.model ? ` · ${run.model}` : ""}
          </summary>
          <StageTable run={run} />
        </details>
      ) : null}
    </div>
  );
}

export function StageTable({ run }: { run: OrganizeRunSummary }) {
  return (
    <div className="stack" style={{ gap: 4, marginTop: 8 }}>
      {run.stats.stages.map((stage) => (
        <div key={stage.stage} className="row small">
          <span style={{ width: 110 }}>{STAGE_LABEL[stage.stage]}</span>
          <span className="muted">{stage.calls} 次调用</span>
          <div className="grow" />
          <span className="muted">
            输入 {formatTokens(stage.inputTokens)} · 输出 {formatTokens(stage.outputTokens)}
          </span>
        </div>
      ))}
    </div>
  );
}
