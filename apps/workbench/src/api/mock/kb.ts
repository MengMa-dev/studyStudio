import {
  KB_REWRITE_SUGGEST_PATCH_COUNT,
  kbDeleteImpactResponseSchema,
  kbDeleteRequestSchema,
  kbDeleteResponseSchema,
  kbEntryDetailSchema,
  kbEntryPatchSchema,
  kbTreeQuerySchema,
  kbTreeResponseSchema,
  type KbDeleteRequestInput,
  type KbEntryKind,
  type KbEntryPatch,
  type KbFlatEntry,
  type KbTreeCategoryNode,
  type KbTreeEntryNode,
  type KbTreeQuery
} from "@study-studio/shared";

type MockEntry = {
  id: string;
  name: string;
  aliases: string[];
  kind: KbEntryKind;
  categoryId: string | null;
  parentId: string | null;
  summary: string;
  bodyMarkdown: string;
  mastery: number | null;
  masterySource: "auto" | "user";
  userEdited: boolean;
  dirty: boolean;
  stale: boolean;
  patchCount: number;
  sourceItemIds: string[];
};

const CATEGORIES = [
  { id: "cat-retrieval", name: "检索", description: "召回、排序与索引" },
  { id: "cat-agent", name: "Agent 框架", description: null }
];

function createEntries(): MockEntry[] {
  const base = { aliases: [], userEdited: false, dirty: false, stale: false, patchCount: 0, masterySource: "auto" as const, parentId: null };
  return [
    {
      ...base,
      id: "kb-rerank",
      name: "重排",
      aliases: ["Rerank"],
      kind: "concept",
      categoryId: "cat-retrieval",
      summary: "对召回结果做二次精排。",
      bodyMarkdown: "## 定义\n\n对召回结果做二次精排。",
      mastery: 0.55,
      sourceItemIds: ["item-p2"]
    },
    {
      ...base,
      id: "kb-cross",
      name: "交叉编码器",
      aliases: ["Cross-Encoder"],
      kind: "model",
      categoryId: "cat-retrieval",
      parentId: "kb-rerank",
      summary: "查询与文档拼接后联合编码打分。",
      bodyMarkdown: "## 定义\n\n查询与文档拼接后联合编码打分。",
      mastery: 0.65,
      patchCount: KB_REWRITE_SUGGEST_PATCH_COUNT,
      sourceItemIds: ["item-p2", "item-q1"]
    },
    {
      ...base,
      id: "kb-bi",
      name: "双塔模型",
      kind: "model",
      categoryId: "cat-retrieval",
      summary: "查询与文档分别编码。",
      bodyMarkdown: "## 定义\n\n查询与文档分别编码。",
      mastery: 0.5,
      sourceItemIds: ["item-p2"]
    },
    {
      ...base,
      id: "kb-bm25",
      name: "BM25",
      kind: "algorithm",
      categoryId: "cat-retrieval",
      summary: "经典词频检索打分。",
      bodyMarkdown: "## 定义\n\n经典词频检索打分。",
      mastery: 0.75,
      userEdited: true,
      sourceItemIds: ["item-q2"]
    },
    {
      ...base,
      id: "kb-hnsw",
      name: "HNSW",
      kind: "algorithm",
      categoryId: "cat-retrieval",
      summary: "分层可导航小世界图索引。",
      bodyMarkdown: "## 定义\n\n分层可导航小世界图索引。",
      mastery: 0.2,
      stale: true,
      sourceItemIds: []
    },
    {
      ...base,
      id: "kb-hitl",
      name: "Human-in-the-loop",
      aliases: ["HITL"],
      kind: "concept",
      categoryId: "cat-agent",
      summary: "执行中暂停等待人工输入。",
      bodyMarkdown: "## 定义\n\n执行中暂停等待人工输入。",
      mastery: null,
      sourceItemIds: ["item-p1"]
    }
  ];
}

let entries: MockEntry[] = createEntries();

export function resetMockKbState(): void {
  entries = createEntries();
}

function toNode(entry: MockEntry): KbTreeEntryNode {
  return {
    id: entry.id,
    name: entry.name,
    aliases: entry.aliases,
    kind: entry.kind,
    summary: entry.summary,
    mastery: entry.mastery,
    masterySource: entry.masterySource,
    stale: entry.stale,
    userEdited: entry.userEdited,
    orphan: entry.sourceItemIds.length === 0,
    sourceCount: entry.sourceItemIds.length,
    children: entries.filter((child) => child.parentId === entry.id).map(toNode)
  };
}

function toFlat(entry: MockEntry): KbFlatEntry {
  const node = toNode(entry);
  return {
    id: node.id,
    name: node.name,
    aliases: node.aliases,
    kind: node.kind,
    summary: node.summary,
    mastery: node.mastery,
    masterySource: node.masterySource,
    stale: node.stale,
    userEdited: node.userEdited,
    orphan: node.orphan,
    sourceCount: node.sourceCount,
    categoryId: entry.categoryId,
    categoryName: CATEGORIES.find((category) => category.id === entry.categoryId)?.name ?? null
  };
}

function categoryNodes(): KbTreeCategoryNode[] {
  return CATEGORIES.map((category) => {
    const members = entries.filter((entry) => entry.categoryId === category.id);
    const scored = members.filter((entry) => entry.mastery !== null);
    return {
      ...category,
      entryCount: members.length,
      avgMastery: scored.length ? scored.reduce((sum, entry) => sum + (entry.mastery ?? 0), 0) / scored.length : null,
      weakEntryCount: scored.filter((entry) => (entry.mastery ?? 0) < 0.4).length,
      children: members.filter((entry) => !entry.parentId).map(toNode)
    };
  });
}

function findEntry(id: string): MockEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Entry not found: ${id}`);
  return entry;
}

function detailOf(id: string) {
  const entry = findEntry(id);
  const category = CATEGORIES.find((candidate) => candidate.id === entry.categoryId) ?? null;
  const parent = entry.parentId ? findEntry(entry.parentId) : null;
  const relations = [
    ...(parent ? [{ id: parent.id, name: parent.name, type: "part_of" as const, direction: "out" as const, mastery: parent.mastery, description: null }] : []),
    ...entries
      .filter((child) => child.parentId === entry.id)
      .map((child) => ({ id: child.id, name: child.name, type: "part_of" as const, direction: "in" as const, mastery: child.mastery, description: null }))
  ];
  return kbEntryDetailSchema.parse({
    id: entry.id,
    name: entry.name,
    aliases: entry.aliases,
    kind: entry.kind,
    categoryId: entry.categoryId,
    categoryName: category?.name ?? null,
    breadcrumb: [
      { type: "category", id: category?.id ?? null, name: category?.name ?? "未分类" },
      ...(parent ? [{ type: "entry", id: parent.id, name: parent.name }] : []),
      { type: "entry", id: entry.id, name: entry.name }
    ],
    summary: entry.summary,
    bodyMarkdown: entry.bodyMarkdown,
    renderedSections: { contrasts: [], faqs: [] },
    completeness: { covered: ["定义"], missing: ["适用场景"] },
    mastery: entry.mastery,
    masterySource: entry.masterySource,
    userEdited: entry.userEdited,
    dirty: entry.dirty,
    stale: entry.stale,
    orphan: entry.sourceItemIds.length === 0,
    patchCount: entry.patchCount,
    suggestRewrite: entry.patchCount >= KB_REWRITE_SUGGEST_PATCH_COUNT,
    updatedAt: "2026-10-02T12:00:00.000Z",
    notes: [],
    sources: entry.sourceItemIds.map((itemId) => ({
      itemId,
      title: itemId,
      type: itemId.startsWith("item-q") ? "conversation" : "webpage",
      url: null,
      site: null,
      sourceKind: itemId.startsWith("item-q") ? "ai_answer" : "blog",
      addedAt: "2026-10-01T12:00:00.000Z",
      evidence: [{ quote: entry.summary }]
    })),
    relations,
    sameCategory: entries
      .filter((candidate) => candidate.categoryId === entry.categoryId && candidate.id !== entry.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name, mastery: candidate.mastery }))
  });
}

export const mockKbApi = {
  async getKbTree(rawQuery: Partial<KbTreeQuery> = {}) {
    const query = kbTreeQuerySchema.parse(rawQuery);
    if (!query.q && !query.kind) {
      return kbTreeResponseSchema.parse({ mode: "tree", categories: categoryNodes(), entries: [], total: entries.length });
    }
    const needle = query.q?.toLowerCase();
    const matched = entries
      .filter((entry) => !query.kind || entry.kind === query.kind)
      .filter((entry) => !needle || [entry.name, ...entry.aliases].some((name) => name.toLowerCase().includes(needle)))
      .map(toFlat);
    return kbTreeResponseSchema.parse({ mode: "flat", categories: [], entries: matched, total: matched.length });
  },

  async getKbEntry(id: string) {
    return detailOf(id);
  },

  async patchKbEntry(id: string, patch: KbEntryPatch) {
    const body = kbEntryPatchSchema.parse(patch);
    const entry = findEntry(id);
    if (body.bodyMarkdown !== undefined) {
      entry.bodyMarkdown = body.bodyMarkdown;
      entry.userEdited = true;
      entry.dirty = true;
    }
    if (body.mastery !== undefined) {
      entry.mastery = body.mastery;
      entry.masterySource = body.mastery === null ? "auto" : "user";
    }
    if (body.categoryId !== undefined) entry.categoryId = body.categoryId;
    return detailOf(id);
  },

  async getKbDeleteImpact(ids: string[]) {
    const targets = entries.filter((entry) => ids.includes(entry.id));
    const children = entries.filter((entry) => entry.parentId && ids.includes(entry.parentId) && !ids.includes(entry.id));
    return kbDeleteImpactResponseSchema.parse({
      entries: targets.map((entry) => ({ id: entry.id, name: entry.name })),
      noteCount: 0,
      relationCount: children.length + targets.filter((entry) => entry.parentId).length,
      reparentedChildren: children.map((child) => {
        const parent = entries.find((entry) => entry.id === child.parentId);
        const newParent = parent?.parentId && !ids.includes(parent.parentId) ? findEntry(parent.parentId) : null;
        return { id: child.id, name: child.name, newParentId: newParent?.id ?? null, newParentName: newParent?.name ?? null };
      }),
      sourceItemCount: new Set(targets.flatMap((entry) => entry.sourceItemIds)).size
    });
  },

  async deleteKbEntries(requestBody: KbDeleteRequestInput) {
    const body = kbDeleteRequestSchema.parse(requestBody);
    const removed = entries.filter((entry) => body.ids.includes(entry.id));
    for (const entry of entries) {
      if (entry.parentId && body.ids.includes(entry.parentId)) entry.parentId = removed.find((parent) => parent.id === entry.parentId)?.parentId ?? null;
    }
    entries = entries.filter((entry) => !body.ids.includes(entry.id));
    return kbDeleteResponseSchema.parse({ trashId: `trash-kb-${Date.now()}`, deletedEntryCount: removed.length });
  }
};
