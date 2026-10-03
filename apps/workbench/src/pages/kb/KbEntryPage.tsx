import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KbEntryDetail } from "@study-studio/shared";
import { api } from "@/api";
import { MarkdownEditor } from "@/components/editor/MarkdownEditor";
import { NotesCard } from "@/components/notes/NotesCard";
import { PendingOrganizeBar } from "@/components/organize/PendingOrganizeBar";
import { RichMarkdown } from "@/components/ui/RichMarkdown";
import { formatCapturedAt, siteShort } from "@/lib/format";
import { formatDateTime, KIND_LABEL, masteryColor, masteryLabel, masteryPercent, RELATION_GROUPS, SOURCE_KIND_LABEL } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { KbDeleteDialog } from "./KbDeleteDialog";
import { ConceptChip } from "./KbPreview";

type Props = { entryId: string };

export function KbEntryPage({ entryId }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const detailKey = ["kb", "entry", entryId];
  const detail = useQuery({ queryKey: detailKey, queryFn: () => api.getKbEntry(entryId) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
  }, [entryId]);

  const save = useMutation({
    mutationFn: (bodyMarkdown: string) => api.patchKbEntry(entryId, { bodyMarkdown }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(detailKey, updated);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["kb", "tree"] });
      pushToast({ message: "已保存，知识点标记为待整理（不会自动整理）" });
    },
    onError: (error) => pushToast({ message: `保存失败：${error instanceof Error ? error.message : String(error)}` })
  });

  if (detail.isError) {
    return (
      <div className="empty">
        词条不存在或已删除。
        <Link to="/wiki">返回知识库</Link>
      </div>
    );
  }
  if (!detail.data) return <div className="empty">加载中…</div>;
  const entry = detail.data;
  const unsaved = editing && draft !== entry.bodyMarkdown;
  const unusedNotes = entry.notes.filter((note) => !note.usedAt).length;
  const organizeThis = () => openOrganize({ scopes: ["entry"], entryIds: [entry.id], targetName: entry.name });

  return (
    <>
      <div className="row small crumbs back-row">
        <Link to="/wiki" search={{ sel: entry.id }} className="btn ghost back-btn">
          <svg
            className="i"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 6-6 6 6 6" />
          </svg>
          返回
        </Link>
        <Link to="/wiki">知识库</Link>
        {entry.breadcrumb.map((crumb, index) => {
          const last = index === entry.breadcrumb.length - 1;
          return (
            <span key={`${crumb.type}-${crumb.id ?? index}`} className="row" style={{ gap: 8 }}>
              <span className="faint">/</span>
              {last ? (
                <span style={{ fontWeight: 600 }}>{crumb.name}</span>
              ) : crumb.type === "entry" && crumb.id ? (
                <Link to="/wiki/$entryId" params={{ entryId: crumb.id }}>
                  {crumb.name}
                </Link>
              ) : (
                <Link to="/wiki" search={{ sel: entry.id }}>
                  {crumb.name}
                </Link>
              )}
            </span>
          );
        })}
      </div>

      <div className="grid cols-main-side">
        <div className="card wiki-article">
          <div className="row">
            <h1>{entry.name}</h1>
            <div className="grow" />
            {editing ? (
              <>
                <span className="editing-badge">{unsaved ? "编辑中 · 未保存" : "编辑中"}</span>
                <button type="button" className="btn sm" onClick={() => setEditing(false)}>
                  取消
                </button>
                <button type="button" className="btn sm primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                  保存
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setDraft(entry.bodyMarkdown);
                    setEditing(true);
                  }}
                >
                  编辑
                </button>
                <button type="button" className="btn sm" data-organize-scope="entry" onClick={organizeThis}>
                  ✦ 重新整理
                </button>
                <details className="more-menu">
                  <summary className="btn sm" title="更多操作" aria-label="更多操作">
                    ⋯
                  </summary>
                  <div className="menu-pop">
                    <Link to="/wiki" search={{ sel: entry.id }}>
                      在知识库中定位
                    </Link>
                    <button type="button" className="danger" onClick={() => setDeleteOpen(true)}>
                      删除知识点
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>
          {entry.aliases.length ? (
            <div className="muted small" style={{ marginTop: 4 }}>
              又称：{entry.aliases.join(" · ")}
            </div>
          ) : null}
          <div className="chips" style={{ marginTop: 10 }}>
            <span className="tag blue">{KIND_LABEL[entry.kind]}</span>
            <span className="tag">{entry.categoryName ?? "未归类"}</span>
            {entry.userEdited ? <span className="tag purple">✎ 手动编辑过</span> : null}
            {entry.stale ? <span className="tag orange">↻ 来源有变化，下次整理更新</span> : null}
            {entry.orphan ? <span className="tag red">无来源</span> : null}
          </div>

          {editing ? null : (
            <>
              {entry.suggestRewrite ? (
                <div className="rewrite-bar" role="note">
                  已累积 {entry.patchCount} 次补丁，正文结构可能变散，建议重新整理
                  <div className="grow" />
                  <button type="button" className="btn sm" data-organize-scope="entry" onClick={organizeThis}>
                    ✦ 重新整理
                  </button>
                </div>
              ) : null}
              <PendingOrganizeBar edited={entry.dirty} unusedNoteCount={unusedNotes} onOrganize={organizeThis} />
            </>
          )}

          {editing ? (
            <div style={{ marginTop: 14 }}>
              <MarkdownEditor value={draft} onChange={setDraft} ariaLabel="词条正文" />
              <div className="small faint" style={{ marginTop: 8 }}>
                Markdown 原样保存，支持代码块与 $公式$。保存后不会自动整理；之后整理也不会覆盖你手动编辑的内容，只追加「整理建议」。
              </div>
            </div>
          ) : (
            <EntryBody entry={entry} />
          )}

          <div className="small faint" style={{ marginTop: 20 }}>
            最后更新 {formatDateTime(entry.updatedAt)} · 累计 {entry.patchCount} 次补丁 · 内容由 {entry.sources.length} 条学习记录生成
          </div>
        </div>

        <div className="stack">
          <MasteryCard entry={entry} />
          <NotesCard
            scope="entry"
            targetId={entry.id}
            title="知识点备注"
            hint="包括整理时从收集点备注带过来的和你后续添加的。整理时作为意图信号；添加后不会自动重新整理"
            notes={entry.notes}
            invalidateKey={detailKey}
          />
          <RelationsCard entry={entry} />
          <SourcesCard entry={entry} />
          {entry.sameCategory.length ? (
            <div className="card">
              <div className="card-title">同分类词条</div>
              <div className="chips">
                {entry.sameCategory.map((other) => (
                  <ConceptChip key={other.id} id={other.id} name={other.name} mastery={other.mastery} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <KbDeleteDialog ids={[entry.id]} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={() => void navigate({ to: "/wiki" })} />
    </>
  );
}

function EntryBody({ entry }: { entry: KbEntryDetail }) {
  const { contrasts, faqs } = entry.renderedSections;
  return (
    <>
      {entry.summary ? <p className="lead">{entry.summary}</p> : null}
      <h3>正文</h3>
      <RichMarkdown markdown={entry.bodyMarkdown || "_暂无正文_"} className="wiki-body" />
      {contrasts.map((contrast) => (
        <section key={contrast.entryId} className="kb-rendered">
          <h3>
            与{" "}
            <Link to="/wiki/$entryId" params={{ entryId: contrast.entryId }}>
              {contrast.name}
            </Link>{" "}
            的区别
          </h3>
          <p className="wiki-body">{contrast.description}</p>
        </section>
      ))}
      {faqs.length ? (
        <section className="kb-rendered">
          <h3>常见疑问</h3>
          <ul className="wiki-body">
            {faqs.map((faq) => (
              <li key={`${faq.itemId}-${faq.question}`}>
                <Link to="/item/$itemId" params={{ itemId: faq.turnItemId ?? faq.itemId }}>
                  {faq.question}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {entry.completeness?.missing.length ? <div className="small faint kb-missing">尚未覆盖：{entry.completeness.missing.join("、")}</div> : null}
    </>
  );
}

function MasteryCard({ entry }: { entry: KbEntryDetail }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<number | null>(null);
  const shown = value ?? (entry.mastery === null ? null : Math.round(entry.mastery * 100));
  const setMastery = useMutation({
    mutationFn: (mastery: number | null) => api.patchKbEntry(entry.id, { mastery }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["kb", "entry", entry.id], updated);
      setValue(null);
      await queryClient.invalidateQueries({ queryKey: ["kb", "tree"] });
    }
  });

  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => setMastery.mutate(value / 100), 400);
    return () => window.clearTimeout(timer);
  }, [value]);

  const current = shown === null ? null : shown / 100;
  return (
    <div className="card">
      <div className="card-title">
        掌握程度
        <span className="more" style={{ fontWeight: 600, color: masteryColor(current) }}>
          {masteryLabel(current)} {masteryPercent(current)}
        </span>
      </div>
      <input
        type="range"
        className="mastery-range"
        aria-label="掌握程度"
        min={0}
        max={100}
        value={shown ?? 0}
        style={{ accentColor: masteryColor(current) }}
        onChange={(event) => setValue(Number(event.target.value))}
      />
      <div className="small muted" style={{ marginTop: 6, lineHeight: 1.8 }}>
        {entry.masterySource === "user" ? (
          <>
            <span className="tag purple">你手动设定</span> 不再自动覆盖 ·{" "}
            <button type="button" className="link-btn" onClick={() => setMastery.mutate(null)}>
              恢复自动计算
            </button>
          </>
        ) : (
          <>自动估算：按来源数、阅读时长、问答次数与备注计算，整理与阅读后更新。拖动滑块可手动设定</>
        )}
      </div>
    </div>
  );
}

function RelationsCard({ entry }: { entry: KbEntryDetail }) {
  const groups = RELATION_GROUPS.map((group) => ({ label: group.label, list: entry.relations.filter(group.match) })).filter((group) => group.list.length);
  return (
    <div className="card">
      <div className="card-title">
        关联词条<span className="more muted">{entry.relations.length} 个</span>
      </div>
      {groups.length ? (
        <table className="table wiki-rel">
          <tbody>
            {groups.map((group) => (
              <tr key={group.label}>
                <td className="muted">{group.label}</td>
                <td>
                  <div className="chips">
                    {group.list.map((relation) => (
                      <ConceptChip key={relation.id} id={relation.id} name={relation.name} mastery={relation.mastery} />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="small faint">暂无关联</div>
      )}
    </div>
  );
}

function SourcesCard({ entry }: { entry: KbEntryDetail }) {
  return (
    <div className="card">
      <div className="card-title">
        来源与摘录<span className="more muted">{entry.sources.length} 条</span>
      </div>
      {entry.sources.length ? null : <div className="small faint">{entry.orphan ? "来源已删除，正文保留为手动内容" : "暂无"}</div>}
      <div className="stack" style={{ gap: 10 }}>
        {entry.sources.map((source) => {
          const icon = siteShort(source.site);
          return (
            <div key={source.itemId} className="kb-source">
              <Link to="/item/$itemId" params={{ itemId: source.itemId }} className="row kb-source-head">
                <span className="src-icon" style={{ background: icon.color, width: 22, height: 22, fontSize: 10 }}>
                  {icon.short}
                </span>
                <span className="grow kb-source-title" title={source.title}>
                  {source.title}
                </span>
              </Link>
              <div className="small faint">
                {SOURCE_KIND_LABEL[source.sourceKind]}
                {source.addedAt ? ` · ${formatCapturedAt(source.addedAt)}` : ""}
              </div>
              {source.evidence.map((evidence, index) => (
                <blockquote key={index} className="kb-evidence">
                  {evidence.question ? (
                    <Link to="/item/$itemId" params={{ itemId: evidence.turnItemId ?? source.itemId }} className="kb-evidence-q">
                      问：{evidence.question}
                    </Link>
                  ) : null}
                  <div>{evidence.quote}</div>
                </blockquote>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
