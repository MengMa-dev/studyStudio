import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizeSettingsUpdate } from "@study-studio/shared";
import { api } from "@/api";
import { formatDateTime } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { setGroup, setRow } from "./SettingsPage";

function Switch({ on, label, disabled, onToggle }: { on: boolean; label: string; disabled?: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} disabled={disabled} onClick={onToggle} />
  );
}

/** 10「整理规则」: master switch, three triggers, output language, last/next run and a manual「整理」. */
export function SettingsOrganize() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const active = useOrganizeStore((state) => state.active);
  const query = useQuery({ queryKey: ["organize-settings"], queryFn: () => api.getOrganizeSettings() });
  const runs = useQuery({ queryKey: ["organize-runs", "latest"], queryFn: () => api.listOrganizeRuns({ limit: 1 }) });
  const [time, setTime] = useState("");
  const [count, setCount] = useState("");

  const save = useMutation({
    mutationFn: (update: OrganizeSettingsUpdate) => api.putOrganizeSettings(update),
    onSuccess: (data) => {
      queryClient.setQueryData(["organize-settings"], data);
      pushToast({ message: "整理规则已保存" });
    },
    onError: (error) => pushToast({ message: `保存失败：${error instanceof Error ? error.message : String(error)}` })
  });

  useEffect(() => {
    if (!query.data) return;
    setTime(query.data.settings.triggers.daily.time);
    setCount(String(query.data.settings.triggers.batch.count));
  }, [query.data]);

  if (!query.data) return <div className="empty">{query.isError ? "加载失败" : "加载中…"}</div>;
  const { settings, lastRunAt, nextRunAt, pendingCount, dirtyCount } = query.data;
  const auto = settings.autoEnabled;
  const triggerClass = `sub ${auto ? "" : "disabled-block"}`;

  const commitCount = () => {
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      pushToast({ message: "数量需为 1–500 的整数" });
      setCount(String(settings.triggers.batch.count));
      return;
    }
    if (value !== settings.triggers.batch.count) save.mutate({ triggers: { batch: { count: value } } });
  };
  const commitTime = () => {
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) && time !== settings.triggers.daily.time) save.mutate({ triggers: { daily: { time } } });
  };

  return (
    <>
      {setGroup(
        "自动整理",
        <>
          {setRow(
            "自动整理",
            auto ? "按下方条件自动整理，可同时开启多个；只处理待整理（新增或上次失败）的内容" : "已关闭，只在你手动点击「整理」时运行",
            <Switch on={auto} label="自动整理" onToggle={() => save.mutate({ autoEnabled: !auto })} />
          )}
          {setRow(
            "每天定时整理",
            "每天在这个时间整理待整理内容",
            <>
              <input
                className="input"
                type="time"
                aria-label="定时整理时间"
                style={{ width: 110 }}
                value={time}
                disabled={!auto || !settings.triggers.daily.enabled}
                onChange={(event) => setTime(event.target.value)}
                onBlur={commitTime}
              />
              <Switch
                on={settings.triggers.daily.enabled}
                label="每天定时整理"
                disabled={!auto}
                onToggle={() => save.mutate({ triggers: { daily: { enabled: !settings.triggers.daily.enabled } } })}
              />
            </>,
            triggerClass
          )}
          {setRow(
            "攒够数量后整理",
            "待整理内容达到数量即跑一批",
            <>
              <input
                className="input"
                type="number"
                aria-label="攒够数量"
                min={1}
                max={500}
                style={{ width: 76 }}
                value={count}
                disabled={!auto || !settings.triggers.batch.enabled}
                onChange={(event) => setCount(event.target.value)}
                onBlur={commitCount}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitCount();
                }}
              />
              <span className="small muted">条</span>
              <Switch
                on={settings.triggers.batch.enabled}
                label="攒够数量后整理"
                disabled={!auto}
                onToggle={() => save.mutate({ triggers: { batch: { enabled: !settings.triggers.batch.enabled } } })}
              />
            </>,
            triggerClass
          )}
          {setRow(
            "入箱即整理",
            "收集后立刻整理，消耗最高",
            <Switch
              on={settings.triggers.onIngest.enabled}
              label="入箱即整理"
              disabled={!auto}
              onToggle={() => save.mutate({ triggers: { onIngest: { enabled: !settings.triggers.onIngest.enabled } } })}
            />,
            triggerClass
          )}
          {setRow(
            `待整理 ${pendingCount} 条${dirtyCount ? ` · 编辑后待整理 ${dirtyCount} 条` : ""}`,
            `上次 ${formatDateTime(lastRunAt)} · 下次 ${auto ? formatDateTime(nextRunAt) : "—"}`,
            <button
              type="button"
              className="btn sm primary"
              data-organize-scope="inbox"
              disabled={Boolean(active)}
              onClick={() => openOrganize({ scopes: ["inbox_pending", "inbox_all"] })}
            >
              {active ? `整理中 ${active.done}/${active.total || "…"}` : "✦ 整理"}
            </button>
          )}
        </>,
        null,
        "已整理且内容没变的记录不会重复整理；编辑内容或新增备注不会触发自动整理；服务未运行时错过的定时任务会在下次启动时补跑"
      )}

      {setGroup(
        "输出",
        setRow(
          "整理语言",
          "知识库正文与摘要的语言",
          <select
            className="input"
            aria-label="整理语言"
            style={{ width: 120 }}
            value={settings.outputLanguage}
            onChange={(event) => save.mutate({ outputLanguage: event.target.value as "zh" | "source" })}
          >
            <option value="zh">中文</option>
            <option value="source">跟随原文</option>
          </select>
        )
      )}

      {setGroup(
        "整理记录",
        setRow(
          `最近一次：${formatDateTime(runs.data?.runs[0]?.startedAt ?? lastRunAt)}`,
          "每次整理的判定结果、知识库变化和消耗",
          <Link to="/runs" className="btn sm">
            查看整理记录 →
          </Link>
        )
      )}
    </>
  );
}
