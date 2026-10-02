import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CAPTURE_PRESETS, applyCaptureRulesUpdate } from "@study-studio/shared";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";
import { setGroup, setRow } from "./SettingsPage";

export function SettingsCollect() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings() });
  const dataInfo = useQuery({ queryKey: ["data-info"], queryFn: () => api.getDataInfo() });

  const save = useMutation({
    mutationFn: (update: Parameters<typeof api.putSettings>[0]) => api.putSettings(update),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      pushToast({ message: "采集设置已保存" });
    }
  });

  const createRule = useMutation({
    mutationFn: () => api.createRule({ kind: "domain", value: "example.com", note: "手动添加" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  if (!settings.data) return <div className="empty">加载中…</div>;
  const capture = settings.data.captureRules;
  const activity = settings.data.activityTracking;
  const platforms = settings.data.conversationPlatforms;

  const applyPreset = (preset: "standard" | "debug") => {
    const next = applyCaptureRulesUpdate(capture, { preset });
    save.mutate({ captureRules: next });
  };

  const updateThreshold = (key: "minActiveSeconds" | "minScrollDepth" | "minRevisitSeconds", value: number) => {
    const next = applyCaptureRulesUpdate(capture, { [key]: key === "minScrollDepth" ? value / 100 : value, preset: "custom" });
    save.mutate({ captureRules: next });
  };

  return (
    <>
      {setGroup(
        "浏览器扩展",
        <>
          {setRow(
            <>
              <span className={`dot ${dataInfo.data?.extensionConnected ? "" : "off"}`} />
              {dataInfo.data?.extensionConnected ? "已连接" : "未连接"}
            </>,
            `离线队列 ${dataInfo.data?.extensionPendingCount ?? 0} 条`,
            <a className="btn sm" href="#">
              安装扩展
            </a>
          )}
          {setRow(
            "配对令牌",
            <span className="mono">{dataInfo.data?.pairingTokenMasked ?? "—"}</span>,
            <button
              type="button"
              className="btn sm"
              onClick={async () => {
                if (dataInfo.data?.pairingToken) {
                  await navigator.clipboard.writeText(dataInfo.data.pairingToken);
                  pushToast({ message: "已复制配对令牌" });
                }
              }}
            >
              复制
            </button>
          )}
        </>
      )}

      {setGroup(
        "正文采集规则",
        <>
          {setRow(
            "入箱所需可见时长",
            "页面在前台可见的累计时间",
            <>
              <input
                type="range"
                min={5}
                max={300}
                value={capture.minActiveSeconds}
                onChange={(event) => updateThreshold("minActiveSeconds", Number(event.target.value))}
              />
              <span className="range-val">{capture.minActiveSeconds} 秒</span>
            </>,
            "range"
          )}
          {setRow(
            "入箱所需滚动深度",
            "读到页面的百分之多少",
            <>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(capture.minScrollDepth * 100)}
                onChange={(event) => updateThreshold("minScrollDepth", Number(event.target.value))}
              />
              <span className="range-val">{Math.round(capture.minScrollDepth * 100)}%</span>
            </>,
            "range"
          )}
          {setRow(
            "再次停留计时下限",
            "之后每次停留超过这个时长才累加阅读时间",
            <>
              <input
                type="range"
                min={3}
                max={300}
                value={capture.minRevisitSeconds}
                onChange={(event) => updateThreshold("minRevisitSeconds", Number(event.target.value))}
              />
              <span className="range-val">{capture.minRevisitSeconds} 秒</span>
            </>,
            "range"
          )}
          {setRow(
            "搜索结果点入采集",
            "从搜索结果打开的页面按规则采集",
            <button
              type="button"
              className={`switch ${capture.captureFromSearch ? "on" : ""}`}
              onClick={() => save.mutate({ captureRules: { captureFromSearch: !capture.captureFromSearch } })}
            />
          )}
        </>,
        <div className="seg">
          <button type="button" className={capture.preset === "standard" ? "active" : ""} onClick={() => applyPreset("standard")}>
            正式
          </button>
          <button type="button" className={capture.preset === "debug" ? "active" : ""} onClick={() => applyPreset("debug")}>
            调试
          </button>
        </div>,
        `正式预设：${CAPTURE_PRESETS.standard.minActiveSeconds}s / ${CAPTURE_PRESETS.standard.minScrollDepth * 100}%；调试预设更低门槛`
      )}

      {setGroup(
        "行为记录",
        <>
          {setRow(
            "记录行为轨迹",
            "搜索、划词、复制、页面会话与内容露出",
            <button
              type="button"
              className={`switch ${activity.enabled ? "on" : ""}`}
              onClick={() => save.mutate({ activityTracking: { enabled: !activity.enabled } })}
            />
          )}
          {setRow(
            "行为日志保留天数",
            "过期后由调度器清理",
            <input
              className="input"
              style={{ width: 80 }}
              type="number"
              value={activity.retentionDays}
              onChange={(event) => save.mutate({ activityTracking: { retentionDays: Number(event.target.value) } })}
            />
          )}
          {setRow("无关站点黑名单", activity.unrelatedDomains.length ? activity.unrelatedDomains.join("、") : "仅使用内置无关类别")}
        </>
      )}

      {setGroup(
        "对话平台",
        <>
          {setRow(
            "ChatGPT",
            "采集提问与完整回答",
            <button
              type="button"
              className={`switch ${platforms.chatgpt ? "on" : ""}`}
              onClick={() => save.mutate({ conversationPlatforms: { chatgpt: !platforms.chatgpt } })}
            />
          )}
          {setRow(
            "DeepSeek",
            "采集提问与完整回答",
            <button
              type="button"
              className={`switch ${platforms.deepseek ? "on" : ""}`}
              onClick={() => save.mutate({ conversationPlatforms: { deepseek: !platforms.deepseek } })}
            />
          )}
        </>
      )}

      {setGroup(
        "排除规则",
        <>
          {settings.data.exclusionRules.map((rule) =>
            setRow(
              <>
                <span className="tag">{rule.kind}</span> <span className="mono">{rule.value}</span>
              </>,
              rule.note,
              <button type="button" className="btn sm ghost danger" onClick={() => deleteRule.mutate(rule.id)}>
                删除
              </button>
            )
          )}
          <details className="set-row set-details">
            <summary>内置列表页规则 · {settings.data.builtinListPageRules.length} 条（只读）</summary>
            <ul>
              {settings.data.builtinListPageRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </details>
        </>,
        <button type="button" className="btn sm" onClick={() => createRule.mutate()}>
          ＋ 添加规则
        </button>,
        "命中规则的页面不会被采集"
      )}
    </>
  );
}
