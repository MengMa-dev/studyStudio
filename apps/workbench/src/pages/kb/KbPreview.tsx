import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { KbTreeCategoryNode } from "@study-studio/shared";
import { api } from "@/api";
import { KIND_LABEL, masteryColor, masteryLabel, masteryPercent, WEAK_MASTERY } from "@/lib/kb";
import type { IndexedEntry } from "./KbPage";

export function ConceptChip({ id, name, mastery }: { id: string; name: string; mastery: number | null }) {
  return (
    <Link to="/wiki/$entryId" params={{ entryId: id }} className="concept-chip" title={name}>
      <i style={{ background: masteryColor(mastery) }} />
      <b className="concept-name">{name}</b>
      <span>{masteryPercent(mastery)}</span>
    </Link>
  );
}

function EntryPreview({ entry, onDelete }: { entry: IndexedEntry; onDelete: (id: string) => void }) {
  const detail = useQuery({ queryKey: ["kb", "entry", entry.id], queryFn: () => api.getKbEntry(entry.id) });
  const relations = detail.data?.relations ?? [];
  return (
    <div className="card kb-preview" data-testid="kb-preview">
      <div className="row wrap">
        <b className="kb-preview-title">{entry.name}</b>
        <span className="tag blue">{KIND_LABEL[entry.kind]}</span>
        {entry.userEdited ? <span className="tag purple">✎ 手动编辑过</span> : null}
        {entry.stale ? <span className="tag orange">↻ 来源有变化</span> : null}
        {entry.orphan ? <span className="tag red">无来源</span> : null}
      </div>
      {entry.aliases.length ? <div className="small muted">又称：{entry.aliases.join(" · ")}</div> : null}
      <div className="row">
        <span className="small muted">{entry.categoryName ?? "未归类"}</span>
        <div className="grow" />
        <span className="small" style={{ color: masteryColor(entry.mastery), fontWeight: 600 }}>
          {masteryLabel(entry.mastery)} {masteryPercent(entry.mastery)}
          {entry.masterySource === "user" ? "（手动）" : ""}
        </span>
      </div>
      <div className="kb-preview-summary">{entry.summary ?? "暂无简介"}</div>
      <div className="small muted">
        {entry.sourceCount} 条来源 · {detail.data ? `${relations.length} 个关联知识点` : "…"}
      </div>
      {relations.length ? (
        <div className="chips">
          {relations.slice(0, 10).map((relation) => (
            <ConceptChip key={`${relation.type}-${relation.id}`} id={relation.id} name={relation.name} mastery={relation.mastery} />
          ))}
        </div>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn sm danger" onClick={() => onDelete(entry.id)}>
          删除
        </button>
        <Link to="/wiki/$entryId" params={{ entryId: entry.id }} className="btn sm primary">
          查看详情
        </Link>
      </div>
    </div>
  );
}

function CategoryPreview({ category, entries }: { category: KbTreeCategoryNode; entries: IndexedEntry[] }) {
  const weak = entries.filter((entry) => entry.categoryId === category.id && entry.mastery !== null && entry.mastery < WEAK_MASTERY);
  return (
    <div className="card kb-preview" data-testid="kb-preview">
      <div className="row">
        <b className="kb-preview-title">{category.name}</b>
        <span className="small muted">{category.description}</span>
      </div>
      <div className="kb-stats">
        <div>
          <div className="small muted">词条</div>
          <b>{category.entryCount}</b>
        </div>
        <div>
          <div className="small muted">平均掌握</div>
          <b style={{ color: masteryColor(category.avgMastery) }}>{masteryPercent(category.avgMastery)}</b>
        </div>
        <div>
          <div className="small muted">薄弱词条</div>
          <b style={{ color: "var(--orange)" }}>{category.weakEntryCount}</b>
        </div>
      </div>
      {weak.length ? (
        <>
          <div className="small muted">需要加强</div>
          <div className="chips">
            {weak.map((entry) => (
              <ConceptChip key={entry.id} id={entry.id} name={entry.name} mastery={entry.mastery} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

type Props = {
  previewKey: string | null;
  categories: KbTreeCategoryNode[];
  entries: IndexedEntry[];
  checkedIds: string[];
  onOrganizeChecked: () => void;
  onDeleteChecked: () => void;
  onClearChecked: () => void;
  onDelete: (id: string) => void;
};

/** Right panel (08): multi-select summary, hovered/selected entry preview, category overview, or KB overview. */
export function KbPreviewPanel({ previewKey, categories, entries, checkedIds, onOrganizeChecked, onDeleteChecked, onClearChecked, onDelete }: Props) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  if (checkedIds.length) {
    const picked = checkedIds.flatMap((id) => byId.get(id) ?? []);
    const scored = picked.filter((entry) => entry.mastery !== null);
    const avg = scored.length ? scored.reduce((sum, entry) => sum + (entry.mastery ?? 0), 0) / scored.length : null;
    return (
      <div className="card kb-preview" data-testid="kb-preview">
        <div className="row">
          <b className="kb-preview-title">已选 {checkedIds.length} 个知识点</b>
          <span className="small muted">平均掌握 {masteryPercent(avg)}</span>
        </div>
        <div className="chips">
          {picked.map((entry) => (
            <ConceptChip key={entry.id} id={entry.id} name={entry.name} mastery={entry.mastery} />
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn sm ghost" onClick={onClearChecked}>
            取消选择
          </button>
          <button type="button" className="btn sm danger" onClick={onDeleteChecked}>
            删除
          </button>
          <button type="button" className="btn sm primary" data-organize-scope="kb_selected" onClick={onOrganizeChecked}>
            ✦ 整理
          </button>
        </div>
      </div>
    );
  }

  if (previewKey?.startsWith("cat:")) {
    const category = categories.find((candidate) => `cat:${candidate.id ?? "none"}` === previewKey);
    if (category) return <CategoryPreview category={category} entries={entries} />;
  }
  const entry = previewKey ? byId.get(previewKey) : undefined;
  if (entry) return <EntryPreview key={entry.id} entry={entry} onDelete={onDelete} />;

  const scored = entries.filter((candidate) => candidate.mastery !== null);
  const avg = scored.length ? scored.reduce((sum, candidate) => sum + (candidate.mastery ?? 0), 0) / scored.length : null;
  const weak = scored.filter((candidate) => (candidate.mastery ?? 0) < WEAK_MASTERY).sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0));
  return (
    <div className="card kb-preview" data-testid="kb-preview">
      <b className="kb-preview-title">分类概况</b>
      <div className="kb-stats">
        <div>
          <div className="small muted">词条</div>
          <b>{entries.length}</b>
        </div>
        <div>
          <div className="small muted">平均掌握</div>
          <b style={{ color: masteryColor(avg) }}>{masteryPercent(avg)}</b>
        </div>
        <div>
          <div className="small muted">薄弱词条</div>
          <b style={{ color: "var(--orange)" }}>{weak.length}</b>
        </div>
      </div>
      {categories.length ? (
        <table className="table">
          <tbody>
            {categories.map((category) => (
              <tr key={category.id ?? "none"}>
                <td>{category.name}</td>
                <td className="muted">{category.entryCount} 个词条</td>
                <td style={{ color: masteryColor(category.avgMastery) }}>{masteryPercent(category.avgMastery)}</td>
                <td className="muted">{category.weakEntryCount ? `薄弱 ${category.weakEntryCount}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {weak.length ? (
        <>
          <div className="small muted">薄弱词条</div>
          <div className="chips">
            {weak.slice(0, 12).map((candidate) => (
              <ConceptChip key={candidate.id} id={candidate.id} name={candidate.name} mastery={candidate.mastery} />
            ))}
          </div>
        </>
      ) : null}
      <div className="small faint">悬停目录中的词条或分类查看预览；勾选后可批量整理或删除</div>
    </div>
  );
}
