import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { BackButton } from "@/components/ui/BackButton";
import { MarkdownView } from "@/components/ui/MarkdownView";
import { formatCapturedAt, fmtDuration, organizeStatusLabel, readStatusLabel, siteShort } from "@/lib/format";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { useModuleMemoryStore } from "@/stores/module-memory";

type Props = { itemId: string };

export function ItemDetailPage({ itemId }: Props) {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const inboxHref = useModuleMemoryStore((state) => state.listHrefFor("inbox"));
  const detail = useQuery({ queryKey: ["item", itemId], queryFn: () => api.getInboxItem(itemId) });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");

  useEffect(() => {
    if (detail.data) {
      setTitle(detail.data.title);
      setMarkdown(detail.data.markdown ?? "");
    }
  }, [detail.data]);

  const saveItem = useMutation({
    mutationFn: () => api.patchInboxItem(itemId, { title, markdown }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
      pushToast({ message: "已保存，内容标记为待整理" });
    }
  });

  const addNote = useMutation({
    mutationFn: () => api.createNote({ scope: "item", targetId: itemId, text: noteDraft, origin: "workbench" }),
    onSuccess: async () => {
      setNoteDraft("");
      await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
    }
  });

  const saveNote = useMutation({
    mutationFn: () => api.patchNote(editingNoteId!, { text: editingNoteText }),
    onSuccess: async () => {
      setEditingNoteId(null);
      await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
    }
  });

  const deleteNote = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["item", itemId] });
    }
  });

  if (detail.isLoading || !detail.data) return <div className="empty">加载中…</div>;
  const item = detail.data;
  const read = readStatusLabel(item.readStatus);
  const organize = organizeStatusLabel(item.organizeStatus);
  const icon = siteShort(item.site);
  const dirtyHint = item.dirty || item.unusedNoteCount > 0;

  return (
    <>
      <BackButton to={inboxHref} />
      <div className="grid cols-main-side">
        <div className="stack">
          <div className="card">
            <div className="detail-head">
              <div className="row">
                <div className="src-icon" style={{ background: icon.color, width: 22, height: 22, fontSize: 10 }}>
                  {icon.short}
                </div>
                <span className="muted">
                  {item.site} · {item.type === "conversation" ? "问答" : "网页"} · {formatCapturedAt(item.capturedAt)} 收集
                </span>
              </div>
              <h2>{item.title}</h2>
              <div className="row wrap">
                <span className={`tag ${read.tone}`}>{read.label}</span>
                <span className={`tag ${organize.tone}`}>{organize.label}</span>
                {item.editedAt ? <span className="tag">✎ 已编辑</span> : null}
                {item.tags.map((tag) => (
                  <span key={tag} className="tag">
                    #{tag}
                  </span>
                ))}
                <div className="grow" />
                {editing ? (
                  <>
                    <span className="editing-badge">编辑中</span>
                    <button type="button" className="btn sm" onClick={() => setEditing(false)}>
                      取消
                    </button>
                    <button type="button" className="btn sm primary" onClick={() => saveItem.mutate()}>
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    {item.url ? (
                      <a className="btn sm" href={item.url} target="_blank" rel="noreferrer">
                        打开原文 ↗
                      </a>
                    ) : null}
                    <button type="button" className="btn sm" onClick={() => setEditing(true)}>
                      编辑内容
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {dirtyHint ? (
            <div className="pending-bar">
              内容已编辑 / {item.unusedNoteCount} 条新备注，尚未用于整理
              <div className="grow" />
              <button
                type="button"
                className="btn sm"
                data-organize-scope="item"
                onClick={() => openOrganize({ scopes: ["item"], itemIds: [item.id], targetName: item.title })}
              >
                ✦ 重新整理
              </button>
            </div>
          ) : null}

          <div className="card">
            {editing ? (
              <>
                <label className="field">
                  标题
                  <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label className="field" style={{ marginTop: 12 }}>
                  {item.type === "conversation" ? "回答" : "正文"}
                  <textarea className="input mono" rows={16} value={markdown} onChange={(event) => setMarkdown(event.target.value)} />
                </label>
              </>
            ) : item.type === "conversation" ? (
              <>
                <div className="qa-q">{item.question}</div>
                {item.reasoning ? (
                  <details className="reasoning">
                    <summary>思考过程</summary>
                    <div style={{ marginTop: 6 }}>{item.reasoning}</div>
                  </details>
                ) : null}
                <MarkdownView markdown={item.markdown ?? ""} />
              </>
            ) : (
              <MarkdownView markdown={item.markdown ?? ""} />
            )}
          </div>
        </div>

        <div className="stack">
          {item.readingSessions.length ? (
            <div className="card">
              <div className="card-title">
                阅读记录
                <span className="more" style={{ fontWeight: 600 }}>
                  {fmtDuration(item.readingTotalSeconds)}
                </span>
              </div>
              {item.readingSessions.map((session) => (
                <div key={session.id} className="session-row">
                  <span>
                    {formatCapturedAt(session.startedAt)}
                    {session.isFirst ? <span className="tag green">首次 · 入箱</span> : null}
                  </span>
                  <span className="muted">{fmtDuration(session.seconds)}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="card">
            <div className="card-title">
              收集点备注
              <span className="more muted">{item.notes.length} 条</span>
            </div>
            <div className="small faint" style={{ marginBottom: 10 }}>
              和这条内容绑定，整理时作为意图信号
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {item.notes.map((note) =>
                editingNoteId === note.id ? (
                  <div key={note.id} className="note">
                    <textarea className="input" rows={3} value={editingNoteText} onChange={(event) => setEditingNoteText(event.target.value)} />
                    <div className="row" style={{ marginTop: 6, justifyContent: "flex-end" }}>
                      <button type="button" className="btn sm ghost" onClick={() => setEditingNoteId(null)}>
                        取消
                      </button>
                      <button type="button" className="btn sm primary" onClick={() => saveNote.mutate()}>
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={note.id} className="note">
                    <div>{note.text}</div>
                    <div className="row small faint" style={{ marginTop: 6 }}>
                      {note.origin}
                      {!note.usedAt ? <span className="tag orange">未用于整理</span> : null}
                      <div className="grow" />
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          setEditingNoteId(note.id);
                          setEditingNoteText(note.text);
                        }}
                      >
                        编辑
                      </button>
                      <button type="button" className="btn sm ghost danger" onClick={() => deleteNote.mutate(note.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
            <textarea
              className="input"
              rows={3}
              style={{ marginTop: 10 }}
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="写下你的理解、疑问或希望整理时关注的点…"
            />
            <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn sm primary" disabled={!noteDraft.trim()} onClick={() => addNote.mutate()}>
                添加备注
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-title">关联知识点</div>
            <div className="chips">
              {item.relatedEntries.length ? (
                item.relatedEntries.map((entry) => (
                  <span key={entry.id} className="chip">
                    {entry.name}
                  </span>
                ))
              ) : (
                <span className="small faint">整理后自动生成</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
