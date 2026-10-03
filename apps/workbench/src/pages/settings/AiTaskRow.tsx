import { useId, useState } from "react";
import type { AiProvider, AiTaskModel, AiTaskModelUpdate } from "@study-studio/shared";
import { TASK_META } from "./ai-labels";

type Props = {
  meta: (typeof TASK_META)[number];
  /** Parent remounts the row (key) when the saved value changes. */
  value: AiTaskModel;
  providers: AiProvider[];
  modelsFor: (providerId: string) => string[];
  saving: boolean;
  onSave: (update: AiTaskModelUpdate) => void;
};

function ModelPicker({
  label,
  providers,
  providerId,
  model,
  modelsFor,
  optional,
  onChange
}: {
  label: string;
  providers: AiProvider[];
  providerId: string;
  model: string;
  modelsFor: Props["modelsFor"];
  optional?: boolean;
  onChange: (providerId: string, model: string) => void;
}) {
  const listId = useId();
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="small muted" style={{ width: 28 }}>
        {label}
      </span>
      <select
        className="input"
        style={{ width: 150 }}
        aria-label={`${label}服务商`}
        value={providerId}
        onChange={(event) => {
          const next = providers.find((provider) => provider.id === event.target.value);
          onChange(event.target.value, next?.defaultModel ?? "");
        }}
      >
        <option value="">{optional ? "不使用" : "选择服务商"}</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
            {provider.status === "connected" ? "" : "（未连接）"}
          </option>
        ))}
      </select>
      <input
        className="input"
        style={{ width: 200 }}
        aria-label={`${label}模型`}
        list={listId}
        value={model}
        disabled={!providerId}
        placeholder="模型 ID"
        onChange={(event) => onChange(providerId, event.target.value)}
      />
      <datalist id={listId}>
        {(providerId ? modelsFor(providerId) : []).map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </div>
  );
}

export function AiTaskRow({ meta, value, providers, modelsFor, saving, onSave }: Props) {
  const [providerId, setProviderId] = useState(value.providerId ?? "");
  const [model, setModel] = useState(value.model ?? "");
  const [fallbackProviderId, setFallbackProviderId] = useState(value.fallbackProviderId ?? "");
  const [fallbackModel, setFallbackModel] = useState(value.fallbackModel ?? "");

  const dirty =
    providerId !== (value.providerId ?? "") ||
    model !== (value.model ?? "") ||
    fallbackProviderId !== (value.fallbackProviderId ?? "") ||
    fallbackModel !== (value.fallbackModel ?? "");
  const valid = providerId !== "" && model.trim() !== "" && (fallbackProviderId === "" || fallbackModel.trim() !== "");

  return (
    <div className="set-row" data-task={meta.task}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="set-label">
          {meta.label}{" "}
          <span className="faint small" style={{ fontWeight: 400 }}>
            {meta.en}
          </span>
        </div>
        <div className="set-desc">{meta.desc}</div>
      </div>
      <div className="set-control" style={{ flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <ModelPicker
          label="主"
          providers={providers}
          providerId={providerId}
          model={model}
          modelsFor={modelsFor}
          onChange={(nextProvider, nextModel) => {
            setProviderId(nextProvider);
            setModel(nextModel);
          }}
        />
        <ModelPicker
          label="备用"
          optional
          providers={providers}
          providerId={fallbackProviderId}
          model={fallbackModel}
          modelsFor={modelsFor}
          onChange={(nextProvider, nextModel) => {
            setFallbackProviderId(nextProvider);
            setFallbackModel(nextProvider ? nextModel : "");
          }}
        />
        {dirty ? (
          <button
            type="button"
            className="btn sm primary"
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                task: meta.task,
                providerId,
                model: model.trim(),
                fallbackProviderId: fallbackProviderId || null,
                fallbackModel: fallbackProviderId ? fallbackModel.trim() : null
              })
            }
          >
            保存
          </button>
        ) : null}
      </div>
    </div>
  );
}
