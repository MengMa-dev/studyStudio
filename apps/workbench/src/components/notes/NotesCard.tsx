import { useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { NoteSummary } from "@study-studio/shared";
import { api } from "@/api";

const ORIGIN_LABEL: Record<string, string> = {
  extension: "扩展",
  workbench: "工作台",
  organize_requirement: "整理要求",
  derived: "由收集点备注派生"
};

type ListProps = {
  scope: "item" | "entry";
  targetId: string;
  /** Entry section id; null / omitted = whole-entry note. */
  anchor?: string | null;
  notes: NoteSummary[];
  invalidateKey: QueryKey;
  placeholder?: string;
  /** Hides the add form behind a button and the empty hint (margin notes). */
  compact?: boolean;
};

type Props = Omit<ListProps, "compact"> & { title: string; hint: string };

/** Note card with add / edit / delete; adding a note never triggers organizing (03 三类备注). */
export function NotesCard({ title, hint, ...list }: Props) {
  return (
    <div className="card">
      <div className="card-title">
        {title}
        <span className="more muted">{list.notes.length} 条</span>
      </div>
      <div className="small faint" style={{ margin: "-4px 0 10px", lineHeight: 1.6 }}>
        {hint}
      </div>
      <NotesList {...list} />
    </div>
  );
}

export function NotesList({
  scope,
  targetId,
  anchor = null,
  notes,
  invalidateKey,
  placeholder = "写下你的理解、疑问或希望整理时关注的点…",
  compact = false
}: ListProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(!compact);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: invalidateKey });

  const add = useMutation({
    mutationFn: (text: string) => api.createNote({ scope, targetId, text: text.trim(), origin: "workbench", ...(anchor && { anchor }) }),
    onSuccess: async () => {
      setDraft("");
      if (compact) setAdding(false);
      await refresh();
    }
  });
  const save = useMutation({
    mutationFn: (input: { id: string; text: string }) => api.patchNote(input.id, { text: input.text.trim() }),
    onSuccess: async () => {
      setEditingId(null);
      await refresh();
    }
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: refresh
  });

  return (
    <>
      <div className="stack" style={{ gap: 8 }}>
        {notes.length || compact ? null : <div className="small faint">还没有备注</div>}
        {notes.map((note) =>
          editingId === note.id ? (
            <div key={note.id} className="note">
              <textarea className="input" rows={3} aria-label="编辑备注" value={editingText} onChange={(event) => setEditingText(event.target.value)} />
              <div className="row" style={{ marginTop: 6, justifyContent: "flex-end" }}>
                <button type="button" className="btn sm ghost" onClick={() => setEditingId(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!editingText.trim()}
                  onClick={() => editingId && save.mutate({ id: editingId, text: editingText })}
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div key={note.id} className="note">
              <div>{note.text}</div>
              <div className="row small faint" style={{ marginTop: 6, flexWrap: "wrap" }}>
                {ORIGIN_LABEL[note.origin] ?? note.origin}
                {scope === "item" && !note.usedAt ? <span className="tag orange">未用于整理</span> : null}
                <div className="grow" />
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    setEditingId(note.id);
                    setEditingText(note.text);
                  }}
                >
                  编辑
                </button>
                <button type="button" className="btn sm ghost danger" onClick={() => remove.mutate(note.id)}>
                  删除
                </button>
              </div>
            </div>
          )
        )}
      </div>
      {adding ? (
        <>
          <textarea
            className="input"
            rows={compact ? 2 : 3}
            style={{ marginTop: compact ? 8 : 10 }}
            aria-label="新备注"
            autoFocus={compact}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
          />
          <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
            {compact ? (
              <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>
                取消
              </button>
            ) : null}
            <button type="button" className="btn sm primary" disabled={!draft.trim() || add.isPending} onClick={() => add.mutate(draft)}>
              添加备注
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn sm ghost kb-margin-add" onClick={() => setAdding(true)}>
          + 添加备注
        </button>
      )}
    </>
  );
}
