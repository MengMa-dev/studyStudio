import { useId, useState } from "react";
import type { ChatOrganizeCardData } from "@study-studio/shared";
import { isRunConflict, useRunOrganize } from "@/components/organize/useRunOrganize";
import { useOrganizeStore } from "@/stores/organize";

type Phase = "idle" | "started" | "conflict";

/** Card state is local: after a reload the card returns to its initial state (no persistence by design). */
export function OrganizeConfirmCard({ data }: { data: ChatOrganizeCardData }) {
  const groupName = useId();
  const single = data.options.length === 1;
  const [index, setIndex] = useState<number | null>(single ? 0 : null);
  const [requirement, setRequirement] = useState(data.requirement ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const active = useOrganizeStore((state) => state.active);
  const openDialog = useOrganizeStore((state) => state.openDialog);
  const run = useRunOrganize({ onStarted: () => setPhase("started") });
  const option = index === null ? null : (data.options[index] ?? null);

  const confirm = () => {
    if (!option) return;
    run.mutate(
      { scope: option.scope, itemIds: option.itemIds, entryIds: option.entryIds, requirement: requirement.trim() || undefined },
      { onError: (error) => setPhase(isRunConflict(error) ? "conflict" : "idle") }
    );
  };

  const adjust = () => {
    openDialog({
      scopes: data.options.map((candidate) => candidate.scope),
      defaultScope: option?.scope,
      itemIds: [...new Set(data.options.flatMap((candidate) => candidate.itemIds))],
      entryIds: [...new Set(data.options.flatMap((candidate) => candidate.entryIds))],
      targetName: (option ?? data.options[0])?.targetName,
      prefill: requirement.trim() || undefined
    });
  };

  if (phase === "started") {
    return (
      <div className="chat-card" aria-label="整理确认">
        <div className="chat-card-title">✦ 已开始整理</div>
        <div className="small muted">{option?.targetName ? `「${option.targetName}」` : option?.label}正在整理，进度见侧栏。</div>
      </div>
    );
  }

  return (
    <div className="chat-card" aria-label="整理确认">
      <div className="chat-card-title">✦ 整理确认</div>
      {single && option ? (
        <div className="chat-card-meta small">
          <span className="muted">范围</span>
          <span>{option.label}</span>
          {option.targetName ? (
            <>
              <span className="muted">目标</span>
              <span>{option.targetName}</span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="segmented chat-card-options" role="radiogroup" aria-label="整理范围">
          {data.options.map((candidate, position) => (
            <label key={`${candidate.scope}:${position}`}>
              <input type="radio" name={groupName} checked={index === position} onChange={() => setIndex(position)} />
              {candidate.label}
              {candidate.targetName ? <span className="faint">「{candidate.targetName}」</span> : null}
            </label>
          ))}
        </div>
      )}
      {option ? (
        <label className="field small">
          整理要求（可选）
          <textarea
            className="input"
            rows={2}
            value={requirement}
            placeholder="例如：重点突出原理，多举例子"
            onChange={(event) => setRequirement(event.target.value)}
          />
        </label>
      ) : (
        <div className="small faint">先选择要整理的范围</div>
      )}
      {phase === "conflict" ? <div className="small chat-card-warn">已有整理在进行，完成后再试</div> : null}
      <div className="row">
        <button type="button" className="btn sm primary" disabled={!option || run.isPending || Boolean(active)} onClick={confirm}>
          {run.isPending ? "发起中…" : "确认整理"}
        </button>
        <button type="button" className="btn sm" onClick={adjust}>
          调整
        </button>
        {active && phase !== "conflict" ? (
          <span className="small faint">
            正在整理（{active.done}/{active.total || "…"}），完成后再试
          </span>
        ) : null}
      </div>
    </div>
  );
}
