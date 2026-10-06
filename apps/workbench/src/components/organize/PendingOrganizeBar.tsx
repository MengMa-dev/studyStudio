type Props = {
  edited: boolean;
  onOrganize: () => void;
};

/** Shown when the entry body was edited after the last organize run; never triggers organizing by itself (08 / 17). */
export function PendingOrganizeBar({ edited, onOrganize }: Props) {
  if (!edited) return null;
  return (
    <div className="pending-bar" role="note">
      内容已编辑，尚未用于整理（不会自动整理）
      <div className="grow" />
      <button type="button" className="btn sm" data-organize-scope="single" onClick={onOrganize}>
        ✦ 重新整理
      </button>
    </div>
  );
}
