type Props = {
  edited: boolean;
  unusedNoteCount: number;
  onOrganize: () => void;
};

/** Shown when edits or notes exist that no organize run has used yet; never triggers organizing by itself (03 / 08). */
export function PendingOrganizeBar({ edited, unusedNoteCount, onOrganize }: Props) {
  if (!edited && unusedNoteCount <= 0) return null;
  const parts = [edited ? "内容已编辑" : "", unusedNoteCount > 0 ? `${unusedNoteCount} 条新备注` : ""].filter(Boolean).join(" / ");
  return (
    <div className="pending-bar" role="note">
      {parts}，尚未用于整理（不会自动整理）
      <div className="grow" />
      <button type="button" className="btn sm" data-organize-scope="single" onClick={onOrganize}>
        ✦ 重新整理
      </button>
    </div>
  );
}
