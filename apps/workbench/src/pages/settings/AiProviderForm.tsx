import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AI_PROVIDER_TYPES, type AiProvider, type AiProviderPatch, type AiProviderTestResponse, type AiProviderType } from "@study-studio/shared";
import { api } from "@/api";
import { BASE_URL_PLACEHOLDER, PROVIDER_TYPE_LABEL, apiErrorMessage } from "./ai-labels";

type Props = {
  /** null = new provider. */
  provider: AiProvider | null;
  models: string[];
  onSaved: (provider: AiProvider) => void;
  onTested: (providerId: string, result: AiProviderTestResponse, persisted: boolean) => void;
  onDeleted?: (providerId: string) => void;
  onCancel?: () => void;
  onError: (message: string) => void;
};

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function AiProviderForm({ provider, models, onSaved, onTested, onDeleted, onCancel, onError }: Props) {
  const listId = useId();
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState<AiProviderType>(provider?.type ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResponse | null>(null);

  const trimmedUrl = baseUrl.trim();
  const urlInvalid = trimmedUrl !== "" && !isUrl(trimmedUrl);
  const baseUrlChanged = trimmedUrl !== (provider?.baseUrl ?? "");

  const buildPatch = (): AiProviderPatch => {
    const patch: AiProviderPatch = {};
    if (!provider) return patch;
    if (name.trim() !== provider.name) patch.name = name.trim();
    if (type !== provider.type) patch.type = type;
    if (baseUrlChanged) patch.baseUrl = trimmedUrl || null;
    if ((defaultModel.trim() || null) !== provider.defaultModel) patch.defaultModel = defaultModel.trim() || null;
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    else if (clearKey) patch.apiKey = null;
    return patch;
  };
  const dirty = provider ? Object.keys(buildPatch()).length > 0 : true;

  const save = useMutation({
    mutationFn: async () => {
      if (!provider) {
        return api.createAiProvider({
          name: name.trim(),
          type,
          baseUrl: trimmedUrl || null,
          defaultModel: defaultModel.trim() || null,
          apiKey: apiKey.trim() || null
        });
      }
      return api.patchAiProvider(provider.id, buildPatch());
    },
    onSuccess: (saved) => {
      setApiKey("");
      setClearKey(false);
      onSaved(saved);
    },
    onError: (error) => onError(apiErrorMessage(error))
  });

  const test = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error("请先保存");
      const overrides = {
        ...(baseUrlChanged && trimmedUrl ? { baseUrl: trimmedUrl } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(defaultModel.trim() ? { model: defaultModel.trim() } : {})
      };
      const result = await api.testAiProvider(provider.id, overrides);
      return { result, persisted: overrides.baseUrl === undefined && overrides.apiKey === undefined };
    },
    onSuccess: ({ result, persisted }) => {
      setTestResult(result);
      if (provider) onTested(provider.id, result, persisted);
    },
    onError: (error) => onError(apiErrorMessage(error))
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!provider) return;
      await api.deleteAiProvider(provider.id);
      onDeleted?.(provider.id);
    },
    onError: (error) => {
      setConfirmDelete(false);
      onError(apiErrorMessage(error));
    }
  });

  const canSave = name.trim() !== "" && !urlInvalid && dirty && !save.isPending;

  return (
    <div className="provider-form" aria-label={provider ? `${provider.name} 配置` : "新服务商"}>
      <div className="form-grid">
        <label className="field">
          名称
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：DeepSeek" />
        </label>
        <label className="field">
          类型
          <select className="input" aria-label="类型" value={type} onChange={(event) => setType(event.target.value as AiProviderType)}>
            {AI_PROVIDER_TYPES.filter((value) => value !== "agent-cli").map((value) => (
              <option key={value} value={value}>
                {PROVIDER_TYPE_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Base URL
        <input
          className="input"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={BASE_URL_PLACEHOLDER[type]}
          aria-invalid={urlInvalid}
        />
        {urlInvalid ? (
          <span className="small" style={{ color: "var(--red)" }}>
            请输入 http(s) 地址
          </span>
        ) : null}
      </label>
      <div className="form-grid">
        <label className="field">
          API Key
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setClearKey(false);
            }}
            placeholder={clearKey ? "保存后清除" : (provider?.apiKeyMasked ?? (type === "ollama" || type === "mock" ? "无需填写" : "sk-..."))}
          />
        </label>
        <label className="field">
          默认模型
          <input className="input" list={listId} value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} placeholder="测试连接后可选" />
          <datalist id={listId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>
      </div>
      {testResult ? (
        <div className="small" role="status" style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>
          {testResult.ok
            ? `连接成功 · ${testResult.latencyMs} ms${testResult.models?.length ? ` · ${testResult.models.length} 个可用模型` : ""}`
            : `连接失败：${testResult.error ?? "未知错误"}`}
        </div>
      ) : null}
      <div className="row">
        <span className="small muted">Key 只保存在本机 secrets.json，界面仅显示掩码，不会进入日志与导出包</span>
        <div className="grow" />
        {provider?.hasApiKey && !apiKey ? (
          <button type="button" className="btn sm ghost" onClick={() => setClearKey(!clearKey)}>
            {clearKey ? "保留 Key" : "清除 Key"}
          </button>
        ) : null}
        {provider ? (
          <button
            type="button"
            className="btn sm ghost danger"
            disabled={remove.isPending}
            onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}
          >
            {confirmDelete ? "确认删除" : "删除"}
          </button>
        ) : (
          <button type="button" className="btn sm ghost" onClick={onCancel}>
            取消
          </button>
        )}
        {provider ? (
          <button type="button" className="btn sm" disabled={test.isPending || urlInvalid} onClick={() => test.mutate()}>
            {test.isPending ? "测试中…" : "测试连接"}
          </button>
        ) : null}
        <button type="button" className="btn sm primary" disabled={!canSave} onClick={() => save.mutate()}>
          {provider ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}
