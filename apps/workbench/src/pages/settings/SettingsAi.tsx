import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiProvider, AiTaskModelUpdate, AiUsageResponse } from "@study-studio/shared";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";
import { AiProviderForm } from "./AiProviderForm";
import { AiTaskRow } from "./AiTaskRow";
import { AgentInstallGroup } from "./SettingsAgent";
import { PROVIDER_TYPE_COLOR, PROVIDER_TYPE_LABEL, TASK_META, apiErrorMessage, formatTokens, providerStatusText } from "./ai-labels";
import { setGroup } from "./SettingsPage";

const PROVIDERS_KEY = ["ai-providers"];
const TASKS_KEY = ["ai-tasks"];
const USAGE_KEY = ["ai-usage"];

function UsageStrip({ usage, saving, onSaveLimit }: { usage: AiUsageResponse; saving: boolean; onSaveLimit: (limit: number | null) => void }) {
  const [draft, setDraft] = useState(usage.dailyTokenLimit === null ? "" : String(usage.dailyTokenLimit));
  const parsed = draft.trim() === "" ? null : Number(draft);
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed <= 0);
  const changed = !invalid && parsed !== usage.dailyTokenLimit;
  const percent = usage.dailyTokenLimit ? Math.min(100, (usage.totalTokens / usage.dailyTokenLimit) * 100) : 0;

  return (
    <div className="usage-strip" aria-label="今日用量">
      <div className="grow">
        <div className="set-desc" style={{ margin: "0 0 4px" }}>
          今日用量（{usage.day}）{usage.limitReached ? <span className="tag red">已达上限</span> : null}
        </div>
        <div>
          <b style={{ fontSize: 18 }}>{formatTokens(usage.totalTokens)}</b>{" "}
          <span className="muted">
            / {usage.dailyTokenLimit === null ? "不限" : formatTokens(usage.dailyTokenLimit)} tokens · {usage.calls} 次调用
          </span>
        </div>
        {usage.dailyTokenLimit !== null ? (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${percent}%`, background: usage.limitReached ? "var(--red)" : "var(--purple)" }} />
          </div>
        ) : null}
      </div>
      <label className="field" style={{ width: 160 }}>
        每日上限（tokens）
        <input
          className="input"
          type="number"
          min={1}
          value={draft}
          placeholder="不限"
          aria-invalid={invalid}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button type="button" className="btn sm" disabled={!changed || saving} onClick={() => onSaveLimit(parsed)}>
        保存上限
      </button>
    </div>
  );
}

export function SettingsAi() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: () => api.listAiProviders() });
  const tasks = useQuery({ queryKey: TASKS_KEY, queryFn: () => api.getAiTasks() });
  const usage = useQuery({ queryKey: USAGE_KEY, queryFn: () => api.getAiUsage() });
  const [openId, setOpenId] = useState<string | null>(null);
  const [testedModels, setTestedModels] = useState<Record<string, string[]>>({});

  const notifyError = (message: string) => pushToast({ message });
  const refreshProviders = () => queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });

  const saveLimit = useMutation({
    mutationFn: (dailyTokenLimit: number | null) => api.putAiLimits({ dailyTokenLimit }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USAGE_KEY });
      pushToast({ message: "每日上限已保存" });
    },
    onError: (error) => notifyError(apiErrorMessage(error))
  });

  const saveTask = useMutation({
    mutationFn: (update: AiTaskModelUpdate) => api.putAiTasks({ tasks: [update] }),
    onSuccess: async (result) => {
      queryClient.setQueryData(TASKS_KEY, result);
      await refreshProviders();
      pushToast({ message: "任务模型已保存" });
    },
    onError: (error) => notifyError(apiErrorMessage(error))
  });

  if (!providers.data || !tasks.data || !usage.data) return <div className="empty">加载中…</div>;
  const providerList = providers.data.providers;
  // Agent providers are managed by the 「一键安装到 Agent」 card and cannot embed.
  const apiProviders = providerList.filter((provider) => provider.type !== "agent-cli");
  const taskList = tasks.data.tasks;

  const modelsFor = (providerId: string): string[] => {
    const provider = providerList.find((candidate) => candidate.id === providerId);
    const used = taskList.flatMap((task) => [
      task.providerId === providerId ? task.model : null,
      task.fallbackProviderId === providerId ? task.fallbackModel : null
    ]);
    return [...new Set([provider?.defaultModel, ...used, ...(testedModels[providerId] ?? [])].filter((model): model is string => Boolean(model)))];
  };

  const providerRow = (provider: AiProvider) => {
    const open = openId === provider.id;
    const toggle = () => setOpenId(open ? null : provider.id);
    return (
      <div key={provider.id}>
        <div
          className={`set-row provider-row ${open ? "open" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          }}
        >
          <div className="provider-logo" style={{ background: PROVIDER_TYPE_COLOR[provider.type] }}>
            {provider.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="set-label">{provider.name}</div>
            <div className="set-desc">
              <span className={`dot ${provider.status === "connected" ? "" : "off"}`} />
              {providerStatusText(provider)}
            </div>
          </div>
          <span className="tag">{PROVIDER_TYPE_LABEL[provider.type]}</span>
          <span className="faint">{open ? "▾" : "▸"}</span>
        </div>
        {open ? (
          <AiProviderForm
            provider={provider}
            models={modelsFor(provider.id)}
            onError={notifyError}
            onSaved={async (saved) => {
              await refreshProviders();
              pushToast({ message: `已保存「${saved.name}」` });
            }}
            onTested={async (providerId, result, persisted) => {
              if (result.models?.length) setTestedModels((current) => ({ ...current, [providerId]: result.models ?? [] }));
              if (persisted) await refreshProviders();
            }}
            onDeleted={async () => {
              setOpenId(null);
              await refreshProviders();
              pushToast({ message: `已删除「${provider.name}」` });
            }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <>
      <UsageStrip
        key={`${usage.data.day}:${usage.data.dailyTokenLimit}`}
        usage={usage.data}
        saving={saveLimit.isPending}
        onSaveLimit={(limit) => saveLimit.mutate(limit)}
      />

      {setGroup(
        "模型服务商",
        <>
          {apiProviders.length === 0 && openId !== "new" ? (
            <div className="set-row">
              <div className="grow set-desc">还没有服务商。添加后在下方为每个任务选择模型。</div>
            </div>
          ) : null}
          {apiProviders.map(providerRow)}
          {openId === "new" ? (
            <AiProviderForm
              provider={null}
              models={[]}
              onError={notifyError}
              onCancel={() => setOpenId(null)}
              onTested={() => {}}
              onSaved={async (created) => {
                await refreshProviders();
                setOpenId(created.id);
                pushToast({ message: `已添加「${created.name}」，可测试连接` });
              }}
            />
          ) : null}
        </>,
        <button type="button" className="btn sm" disabled={openId === "new"} onClick={() => setOpenId("new")}>
          ＋ 添加服务商
        </button>,
        "点击服务商展开配置；达到每日上限后自动整理会暂停，手动整理需确认后继续"
      )}

      <AgentInstallGroup />

      {setGroup(
        "按任务选择模型",
        <>
          {TASK_META.map((meta) => {
            const value = taskList.find((task) => task.task === meta.task) ?? {
              task: meta.task,
              providerId: null,
              model: null,
              fallbackProviderId: null,
              fallbackModel: null
            };
            return (
              <AiTaskRow
                key={`${meta.task}:${value.providerId}:${value.model}:${value.fallbackProviderId}:${value.fallbackModel}`}
                meta={meta}
                value={value}
                providers={meta.task === "embedding" ? apiProviders : providerList}
                modelsFor={modelsFor}
                saving={saveTask.isPending}
                onSave={(update) => saveTask.mutate(update)}
              />
            );
          })}
        </>,
        undefined,
        "主模型 429 / 5xx 重试耗尽后切到备用模型"
      )}
    </>
  );
}
