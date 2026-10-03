import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrganizePreviewResponse, OrganizeScope } from "@study-studio/shared";
import { api } from "@/api";
import { Modal } from "@/components/ui/Modal";
import { useOrganizeStore, type OrganizeDialogRequest } from "@/stores/organize";
import { useRunOrganize } from "./useRunOrganize";

export const REQUIREMENT_CHIPS = ["上次整理的不对，请重新理解", "重点突出原理和适用场景", "多举具体例子", "更简洁，只保留核心", "和相关知识点做对比"];

const KB_SCOPES = new Set<OrganizeScope>(["kb_selected", "kb_pending", "kb_all", "entry"]);

function titleOf(scope: OrganizeScope, request: OrganizeDialogRequest): string {
  const items = request.itemIds?.length ?? 0;
  const entries = request.entryIds?.length ?? 0;
  switch (scope) {
    case "item":
      return `整理「${request.targetName ?? "当前内容"}」`;
    case "entry":
      return `重新整理知识点「${request.targetName ?? "当前知识点"}」`;
    case "inbox_selected":
      return `整理已选的 ${items} 条内容`;
    case "inbox_pending":
      return "批量整理待整理内容";
    case "inbox_all":
      return "全量重新整理收集箱";
    case "kb_selected":
      return `重新整理已选的 ${entries} 个知识点`;
    case "kb_pending":
      return "重新整理待整理的知识点";
    case "kb_all":
      return "全量重新整理知识库";
  }
}

function optionLabel(scope: OrganizeScope, request: OrganizeDialogRequest, pendingCount: number | undefined): [string, string] {
  switch (scope) {
    case "inbox_selected":
      return ["刚才已选的", `${request.itemIds?.length ?? 0} 项`];
    case "kb_selected":
      return ["已选知识点", `${request.entryIds?.length ?? 0} 个`];
    case "inbox_pending":
      return ["待整理", pendingCount === undefined ? "" : `${pendingCount} 条`];
    case "kb_pending":
      return ["待整理", "已编辑或来源有变化"];
    case "inbox_all":
    case "kb_all":
      return ["全量", ""];
    case "item":
      return ["当前条目", ""];
    case "entry":
      return ["当前知识点", ""];
  }
}

const HINT: Partial<Record<OrganizeScope, string>> = {
  inbox_pending: "只整理还没整理过、整理失败或编辑后的内容",
  inbox_all: "重新整理全部内容并重建知识库关系，耗时和 token 较多；手动编辑过的知识点只补充不覆盖",
  kb_pending: "重写手动编辑后或来源有变化的知识点",
  kb_all: "按来源重写全部知识点，耗时较多；手动编辑过的知识点只追加「整理建议」"
};

function targetOf(scope: OrganizeScope): string {
  if (scope === "item") return "这条内容的「收集点备注」";
  if (scope === "entry") return "这个知识点的「知识点备注」";
  return "时间线上的「模糊备注」，整理时按语义匹配到相关内容";
}

function signalsText(scope: OrganizeScope, preview: OrganizePreviewResponse): string {
  const newNotes = preview.newNoteCount ? `（其中 ${preview.newNoteCount} 条新加）` : "";
  if (KB_SCOPES.has(scope)) {
    return `本次会重写 ${preview.entryCount} 个知识点，使用 ${preview.noteCount} 条知识点备注${newNotes}。手动编辑过的内容会保留，只补充不覆盖`;
  }
  const fuzzy = preview.fuzzyNoteCount ? `，含 ${preview.fuzzyNoteCount} 条模糊备注` : "";
  const edited = preview.editedItemCount ? `，以及 ${preview.editedItemCount} 条编辑后的内容` : "";
  return `本次会整理 ${preview.itemCount} 条内容（${preview.newItemCount} 条新内容），使用 ${preview.noteCount} 条收集点 / 模糊备注${newNotes}${fuzzy}${edited}`;
}

export { isRunConflict } from "./useRunOrganize";

export function OrganizeDialogHost() {
  const request = useOrganizeStore((state) => state.dialog);
  const closeDialog = useOrganizeStore((state) => state.closeDialog);
  if (!request) return null;
  return <OrganizeDialog key={JSON.stringify(request)} request={request} onClose={closeDialog} />;
}

function OrganizeDialog({ request, onClose }: { request: OrganizeDialogRequest; onClose: () => void }) {
  const active = useOrganizeStore((state) => state.active);
  const [scope, setScope] = useState<OrganizeScope>(request.defaultScope ?? request.scopes[0] ?? "inbox_pending");
  const [requirement, setRequirement] = useState(request.prefill ?? "");
  const [allowOverLimit, setAllowOverLimit] = useState(false);
  const itemIds = request.itemIds ?? [];
  const entryIds = request.entryIds ?? [];

  const settings = useQuery({ queryKey: ["organize-settings"], queryFn: () => api.getOrganizeSettings() });
  const preview = useQuery({
    queryKey: ["organize-preview", scope, itemIds.join(","), entryIds.join(",")],
    queryFn: () => api.previewOrganize({ scope, itemIds, entryIds }),
    staleTime: 0
  });

  useEffect(() => setAllowOverLimit(false), [scope]);

  const run = useRunOrganize({ onStarted: onClose });

  const total = preview.data ? preview.data.itemCount + preview.data.entryCount : 0;
  const needsConfirm = preview.data?.overDailyLimit && !allowOverLimit;
  const disabled = Boolean(active) || run.isPending || !preview.data || total === 0 || needsConfirm;

  const submit = () => {
    if (!disabled) run.mutate({ scope, itemIds, entryIds, requirement: requirement.trim() || undefined, allowOverLimit });
  };

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} title={titleOf(scope, request)} className="organize-modal">
      <div className="stack" style={{ gap: 14 }}>
        {request.scopes.length > 1 ? (
          <div className="field-block">
            整理范围
            <div className="segmented" role="radiogroup" aria-label="整理范围">
              {request.scopes.map((option) => {
                const [label, count] = optionLabel(option, request, settings.data?.pendingCount);
                return (
                  <label key={option}>
                    <input type="radio" name="organize-scope" value={option} checked={scope === option} onChange={() => setScope(option)} />
                    {label}
                    {count ? <span className="faint">{count}</span> : null}
                  </label>
                );
              })}
            </div>
            {HINT[scope] ? <div className="small faint">{HINT[scope]}</div> : null}
          </div>
        ) : null}

        <div className="small muted" style={{ lineHeight: 1.7 }} data-testid="organize-signals">
          {preview.isLoading
            ? "正在统计本次会使用的内容…"
            : preview.data
              ? total
                ? `${signalsText(scope, preview.data)}。`
                : "没有需要整理的内容。"
              : "统计失败，仍可开始整理。"}
        </div>

        {preview.data?.overDailyLimit ? (
          <label className="row small" style={{ color: "var(--orange)" }}>
            <input type="checkbox" checked={allowOverLimit} onChange={(event) => setAllowOverLimit(event.target.checked)} />
            今日 token 已接近上限，仍然继续
          </label>
        ) : null}

        <label className="field">
          整理要求（可选）
          <textarea
            className="input"
            rows={4}
            value={requirement}
            autoFocus
            placeholder="例如：上次整理的不对，重点突出它和双塔模型的区别，多举例子"
            onChange={(event) => setRequirement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="chips">
          {REQUIREMENT_CHIPS.map((text) => (
            <button key={text} type="button" className="chip" onClick={() => setRequirement((value) => (value.trim() ? `${value}；${text}` : text))}>
              {text}
            </button>
          ))}
        </div>
        <div className="small faint" style={{ lineHeight: 1.6 }}>
          填写的要求会保存为{targetOf(scope)}，作为本次及以后整理的意图信号。
        </div>
        {active ? (
          <div className="small" style={{ color: "var(--purple)" }}>
            正在整理（{active.done}/{active.total || "…"}），完成后再试
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="kbd-hint">⌘ Enter 开始 · Esc 取消</span>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={disabled} onClick={submit}>
            {run.isPending ? "发起中…" : "开始整理"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
