import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { formatDateTime, formatTokens } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";
import { RunCard } from "./RunCard";

export function RunsPage() {
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const settings = useQuery({ queryKey: ["organize-settings"], queryFn: () => api.getOrganizeSettings() });
  const runs = useInfiniteQuery({
    queryKey: ["organize-runs"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listOrganizeRuns({ cursor: pageParam, limit: 20 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined
  });
  const list = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const sum = (pick: (run: (typeof list)[number]) => number) => list.reduce((total, run) => total + pick(run), 0);
  const s = settings.data;

  return (
    <>
      <div className="page-header">
        <h1>整理记录</h1>
        <span className="sub">
          共 {list.length}
          {runs.hasNextPage ? "+" : ""} 次 · 每次整理的判定结果、知识库变化和消耗
        </span>
        <div className="actions">
          <Link to="/settings/$section" params={{ section: "organize" }} className="btn">
            整理规则
          </Link>
          <button type="button" className="btn primary" data-organize-scope="inbox" onClick={() => openOrganize({ scopes: ["inbox_pending", "inbox_all"] })}>
            ✦ 整理
          </button>
        </div>
      </div>
      <div className="run-summary">
        <div className="card">
          <div className="small muted">自动整理</div>
          <b>{s ? (s.settings.autoEnabled ? "已开启" : "已关闭") : "—"}</b>
          <div className="small faint">
            上次 {formatDateTime(s?.lastRunAt ?? null)} · 下次 {formatDateTime(s?.nextRunAt ?? null)}
          </div>
        </div>
        <div className="card">
          <div className="small muted">待整理</div>
          <b style={{ color: "var(--purple)" }}>{s?.pendingCount ?? "—"}</b>
          <div className="small faint">条收集内容{s?.dirtyCount ? ` · ${s.dirtyCount} 条编辑后待整理` : ""}</div>
        </div>
        <div className="card">
          <div className="small muted">近 {list.length} 次 已入库 / 未采纳</div>
          <b>
            <span style={{ color: "var(--green)" }}>{sum((run) => run.stats.items.ingested)}</span> /{" "}
            <span style={{ color: "var(--orange)" }}>{sum((run) => run.stats.items.rejected)}</span>
          </b>
          <div className="small faint">失败 {sum((run) => run.stats.items.failed)} 条</div>
        </div>
        <div className="card">
          <div className="small muted">近 {list.length} 次消耗</div>
          <b>{formatTokens(sum((run) => run.tokens))}</b>
          <div className="small faint">tokens</div>
        </div>
      </div>
      {runs.isLoading ? <div className="empty">加载中…</div> : null}
      {runs.isError ? <div className="empty">加载失败：{String(runs.error)}</div> : null}
      {runs.data && !list.length ? <div className="empty">还没有整理记录。可在收集箱或知识库点击「✦ 整理」</div> : null}
      <div className="stack" style={{ gap: 12 }}>
        {list.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>
      {runs.hasNextPage ? (
        <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
          <button type="button" className="btn" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
            {runs.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </>
  );
}
