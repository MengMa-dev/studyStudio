import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/api";
import { EllipsisText } from "@/components/ui/EllipsisText";
import { fmtDuration, fmtMinutes, fmtShort, formatClock } from "@/lib/format";

const TYPE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "webpage", label: "网页学习" },
  { id: "conversation", label: "AI 问答" },
  { id: "document", label: "文档" },
  { id: "fuzzy", label: "模糊备注" }
] as const;

export function ProgressPage() {
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const typesParam = useMemo(() => (types.size ? [...types].join(",") : undefined), [types]);
  const timeline = useQuery({
    queryKey: ["timeline", typesParam],
    queryFn: () => api.getTimeline({ types: typesParam })
  });
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.getOverview() });
  const presence = useQuery({
    queryKey: ["presence"],
    queryFn: () => api.getPresence(),
    refetchInterval: 5000
  });

  const week = overview.data?.week ?? [];
  const max = Math.max(1, ...week.map((day) => day.minutes));
  const sources = overview.data?.sources ?? [];
  const maxSource = Math.max(1, ...sources.map((source) => source.minutes));

  return (
    <>
      <div className="page-header">
        <h1>学习进度</h1>
        <span className="sub">时间线只记录学习行为，按时间逐条展示</span>
        <div className="actions">
          <select className="input" style={{ width: 130 }} defaultValue="7">
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
          </select>
        </div>
      </div>
      <div className="progress-layout">
        <div>
          <div className="chips" style={{ marginBottom: 18 }}>
            {TYPE_FILTERS.map((filter) => {
              const active = filter.id === "all" ? types.size === 0 : types.has(filter.id);
              return (
                <button
                  key={filter.id}
                  type="button"
                  className={`chip ${active ? "active" : ""}`}
                  onClick={() => {
                    if (filter.id === "all") setTypes(new Set());
                    else {
                      setTypes((current) => {
                        const next = new Set(current);
                        if (next.has(filter.id)) next.delete(filter.id);
                        else next.add(filter.id);
                        return next;
                      });
                    }
                  }}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
          {timeline.data?.days.map((day) => {
            const isCollapsed = collapsed.has(day.day);
            return (
              <div key={day.day} className={`day ${isCollapsed ? "collapsed" : ""}`}>
                <div
                  className="day-head"
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(day.day)) next.delete(day.day);
                      else next.add(day.day);
                      return next;
                    })
                  }
                >
                  <h3>{day.label.split(" · ")[0]}</h3>
                  <span className="muted">{day.label.split(" · ")[1] ?? ""}</span>
                  <span className="tag blue">学习 {fmtMinutes(day.minutes)}</span>
                  <div className="grow" />
                  <span className="small muted">{day.rows.length} 条</span>
                </div>
                {!isCollapsed ? (
                  day.rows.length ? (
                    <div className="day-body">
                      {day.rows.map((row) => (
                        <div
                          key={row.id}
                          className={`event ${row.type === "fuzzy" ? "fuzzy" : ""}`}
                          onClick={() => {
                            if (row.itemId) window.location.hash = `#/item/${row.itemId}`;
                          }}
                        >
                          <span className="time">{formatClock(row.startedAt)}</span>
                          <span className="ico">
                            {row.type === "fuzzy" ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                              </svg>
                            ) : row.type === "conversation" ? (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <path d="M21 11.5a8.4 8.4 0 0 1-12.8 7.2L3 20l1.4-4.8A8.4 8.4 0 1 1 21 11.5z" />
                              </svg>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <path d="M14 2v6h6M16 13H8M16 17H8" />
                              </svg>
                            )}
                          </span>
                          <span className="ev-main">
                            <EllipsisText text={row.title} className="ev-title" />
                            {row.tags.map((tag) => (
                              <span key={tag} className="tag">
                                {tag}
                              </span>
                            ))}
                            {row.durationSeconds ? <span className="tag">{fmtDuration(row.durationSeconds)}</span> : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="small faint day-empty">没有符合条件的记录</div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="stack">
          {presence.data?.active ? (
            <div className="live">
              <div className="pulse" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small muted">正在学习 · 来自浏览器扩展</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>{presence.data.title}</div>
                <div className="row" style={{ marginTop: 4 }}>
                  <span className="tag">{presence.data.site}</span>
                  {presence.data.captured ? <span className="tag green">已收集</span> : null}
                  <div className="grow" />
                  <span style={{ fontWeight: 650 }}>{fmtDuration(presence.data.seconds ?? 0)}</span>
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid cols-2" style={{ gap: 12 }}>
            <div className="card stat">
              <div className="label">今日学习时长</div>
              <div className="value">{fmtMinutes(overview.data?.today.minutes ?? 0)}</div>
              <div className="delta">连续学习 {overview.data?.today.streak ?? 0} 天</div>
            </div>
            <div className="card stat">
              <div className="label">新收网页</div>
              <div className="value">{overview.data?.today.pages ?? 0}</div>
            </div>
            <div className="card stat">
              <div className="label">AI 问答</div>
              <div className="value">{overview.data?.today.qa ?? 0}</div>
            </div>
            <div className="card stat">
              <div className="label">备注</div>
              <div className="value">{overview.data?.today.notes ?? 0}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              近 7 天学习时长
              <span className="more muted">合计 {fmtMinutes(week.reduce((sum, day) => sum + day.minutes, 0))}</span>
            </div>
            <div className="bars">
              {week.map((day, index) => (
                <div key={day.day} className="bar-col">
                  <div className={`bar ${index === week.length - 1 ? "today" : ""}`} style={{ height: `${(day.minutes / max) * 100}%` }}>
                    <span>{day.minutes ? fmtShort(day.minutes) : ""}</span>
                  </div>
                  <div className="small muted">{day.day}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-title">待处理</div>
            <Link className="todo" to="/inbox" search={{ type: "all", status: "unread" }}>
              <span className="num" style={{ color: "var(--primary)" }}>
                {overview.data?.pending.unread ?? 0}
              </span>
              <div className="grow">
                <div>未读内容</div>
                <div className="small muted">收进来但还没回顾</div>
              </div>
              <span className="faint">→</span>
            </Link>
            <Link className="todo" to="/inbox" search={{ type: "all", status: "pending" }}>
              <span className="num" style={{ color: "var(--purple)" }}>
                {overview.data?.pending.pendingOrganize ?? 0}
              </span>
              <div className="grow">
                <div>待 AI 整理</div>
                <div className="small muted">生成摘要、要点与知识点</div>
              </div>
              <span className="faint">→</span>
            </Link>
            <Link className="todo" to="/wiki">
              <span className="num" style={{ color: "var(--orange)" }}>
                {overview.data?.pending.weakEntries ?? 0}
              </span>
              <div className="grow">
                <div>薄弱知识点</div>
                <div className="small muted">掌握度低于 30%</div>
              </div>
              <span className="faint">→</span>
            </Link>
          </div>

          <div className="card">
            <div className="card-title">
              来源分布<span className="more muted">近 7 天</span>
            </div>
            {sources.map((source) => (
              <div key={source.name} className="hbar">
                <span className="hbar-label" title={source.name}>
                  {source.name}
                </span>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(source.minutes / maxSource) * 100}%` }} />
                </div>
                <span className="small muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {fmtShort(source.minutes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
