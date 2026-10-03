import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { BackButton } from "@/components/ui/BackButton";
import { EllipsisText } from "@/components/ui/EllipsisText";
import { DECISION_TEXT, formatDateTime, formatElapsed, formatTokens, RUN_ITEM_STATUS } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";
import { episodeText, kbChangeText, RunProgress, RunStatusTags, StageTable, useRetryRun } from "./RunCard";

const CHANGE_LABEL = { created: ["新增", "green"], supplemented: ["补充", "teal"], duplicate: ["重复挂来源", "blue"], rewritten: ["重写", "purple"] } as const;

export function RunDetailPage({ runId }: { runId: string }) {
  const activeRunId = useOrganizeStore((state) => state.active?.runId);
  const run = useQuery({
    queryKey: ["organize-run", runId],
    queryFn: () => api.getOrganizeRun(runId),
    refetchInterval: activeRunId === runId ? 1000 : false
  });
  const retry = useRetryRun();

  if (run.isError) {
    return (
      <>
        <BackButton to="/runs" />
        <div className="empty">记录不存在</div>
      </>
    );
  }
  if (!run.data) return <div className="empty">加载中…</div>;
  const data = run.data;
  const elapsed = formatElapsed(data.startedAt, data.finishedAt);

  return (
    <>
      <BackButton to="/runs" />
      <div className="stack" style={{ gap: 12 }}>
        <div className="card run-card">
          <div className="row wrap">
            <h2 style={{ fontSize: 18 }}>{formatDateTime(data.startedAt)} 的整理</h2>
            <RunStatusTags run={data} />
            {elapsed ? <span className="small faint">耗时 {elapsed}</span> : null}
            <div className="grow" />
            {data.failures.length ? (
              <button type="button" className="btn sm primary" disabled={retry.isPending} onClick={() => retry.mutate(data.id)}>
                重试失败项（{data.failures.length}）
              </button>
            ) : null}
          </div>
          {data.requirement ? <div className="small muted">整理要求：{data.requirement}</div> : null}
          <RunProgress run={data} />
          <div className="run-stats">
            <div>
              <div className="small muted">处理条目</div>
              <b>{data.stats.items.total}</b>
            </div>
            <div>
              <div className="small muted">活动片段</div>
              <b className="small-b">{episodeText(data)}</b>
            </div>
            <div>
              <div className="small muted">已入库</div>
              <b style={{ color: "var(--green)" }}>{data.stats.items.ingested}</b>
            </div>
            <div>
              <div className="small muted">未采纳</div>
              <b style={{ color: "var(--orange)" }}>{data.stats.items.rejected}</b>
            </div>
            <div>
              <div className="small muted">知识库变化</div>
              <b className="small-b">{kbChangeText(data)}</b>
            </div>
          </div>
          <div className="small muted">
            {formatTokens(data.tokens)} tokens{data.model ? ` · ${data.model}` : ""}
          </div>
          {data.stats.stages.length ? <StageTable run={data} /> : null}
        </div>

        {data.failures.length ? (
          <div className="card">
            <div className="card-title">
              失败项<span className="more muted">{data.failures.length} 个</span>
            </div>
            {data.failures.map((failure) => (
              <div key={failure.jobId} className="row small run-failure">
                <span className="tag red">{failure.kind}</span>
                <span className="grow">{data.items.find((item) => item.itemId === failure.targetId)?.title ?? failure.targetId ?? "—"}</span>
                <span className="muted">重试 {failure.attempts} 次</span>
                <span style={{ color: "var(--red)" }}>{failure.error}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="card">
          <div className="card-title">
            处理条目<span className="more muted">{data.items.length} 条</span>
          </div>
          {data.items.length ? (
            <table className="table run-items">
              <tbody>
                {data.items.map((item) => {
                  const status = RUN_ITEM_STATUS[item.status];
                  return (
                    <tr key={item.itemId}>
                      <td style={{ maxWidth: 320 }}>
                        <Link to="/item/$itemId" params={{ itemId: item.itemId }}>
                          <EllipsisText text={item.title} />
                        </Link>
                      </td>
                      <td>
                        <span className={`tag ${status.tone}`}>{status.label}</span>
                      </td>
                      <td className="muted">{item.decision ? DECISION_TEXT[item.decision] : "—"}</td>
                      <td className="muted mono small">{item.route ?? ""}</td>
                      <td>
                        {item.error ? <span style={{ color: "var(--red)" }}>{item.error}</span> : null}
                        <div className="chips">
                          {item.entryIds.map((id) => (
                            <Link key={id} to="/wiki/$entryId" params={{ entryId: id }} className="chip">
                              {data.entries.find((change) => change.entryId === id)?.name ?? id}
                            </Link>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="small faint">本次只处理知识点</div>
          )}
        </div>

        <div className="card">
          <div className="card-title">
            知识库变化<span className="more muted">{data.entries.length} 个知识点</span>
          </div>
          {data.entries.length ? (
            <div className="chips">
              {data.entries.map((change) => {
                const [label, tone] = CHANGE_LABEL[change.change];
                return (
                  <Link key={`${change.entryId}-${change.change}`} to="/wiki/$entryId" params={{ entryId: change.entryId }} className="concept-chip">
                    <span className={`tag ${tone}`}>{label}</span>
                    {change.name}
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="small faint">无变化</div>
          )}
        </div>
      </div>
    </>
  );
}
