import { useMemo, useState } from "react";
import type { LearnerProfile } from "@study-studio/shared";

const ROLE_CHIPS = ["前端开发", "产品经理", "算法工程师", "研究生"];

type Props = {
  initial: LearnerProfile;
  onSave: (profile: LearnerProfile) => void;
  onCancel: () => void;
  saving?: boolean;
};

export function ProfileEditor({ initial, onSave, onCancel, saving }: Props) {
  const [role, setRole] = useState(initial.role);
  const [directions, setDirections] = useState(initial.directions);
  const [newText, setNewText] = useState("");
  const [days, setDays] = useState(30);

  const draft = useMemo<LearnerProfile>(() => ({ role, directions }), [role, directions]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <label className="field">
        角色
        <input className="input" value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：前端开发" />
      </label>
      <div className="chips">
        {ROLE_CHIPS.map((chip) => (
          <button key={chip} type="button" className={`chip ${chip === role ? "active" : ""}`} onClick={() => setRole(chip)}>
            {chip}
          </button>
        ))}
      </div>
      <div className="field-block">
        <div style={{ marginBottom: 8 }}>近期学习方向</div>
        <div className="stack" style={{ gap: 8 }}>
          {directions.map((direction) => (
            <div key={direction.id} className="focus-row">
              <div className="grow">
                <div>{direction.text}</div>
                <div className="small muted">{direction.expiresAt} 到期</div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setDirections((current) =>
                    current.map((entry) =>
                      entry.id === direction.id
                        ? {
                            ...entry,
                            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
                          }
                        : entry
                    )
                  )
                }
              >
                续期 30 天
              </button>
              <button
                type="button"
                className="btn sm ghost danger"
                onClick={() => setDirections((current) => current.filter((entry) => entry.id !== direction.id))}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input grow" value={newText} onChange={(event) => setNewText(event.target.value)} placeholder="例如：Agent 架构" />
          <select className="input" style={{ width: 110 }} value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
          </select>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const text = newText.trim();
              if (!text) return;
              setDirections((current) => [
                ...current,
                {
                  id: `dir-${Date.now()}`,
                  text,
                  expiresAt: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
                }
              ]);
              setNewText("");
            }}
          >
            添加
          </button>
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={saving} onClick={() => onSave(draft)}>
          保存
        </button>
      </div>
    </div>
  );
}
