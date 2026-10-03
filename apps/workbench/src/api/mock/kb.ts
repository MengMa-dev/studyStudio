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
  type KbEvidence,
  type KbFlatEntry,
  type KbRelation,
  type KbRelationType,
  type KbSourceKind,
  type KbTreeCategoryNode,
  type KbTreeEntryNode,
  type KbTreeQuery,
  type Note
} from "@study-studio/shared";

import { getMockState } from "./client";
import type { MockItem } from "./seed";

type SourceRef = { itemId: string; sourceKind: KbSourceKind; evidence: KbEvidence[] };

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
  /** Value restored by「恢复自动」. */
  autoMastery: number | null;
  masterySource: "auto" | "user";
  userEdited: boolean;
  dirty: boolean;
  stale: boolean;
  patchCount: number;
  completeness: { covered: string[]; missing: string[] } | null;
  updatedAt: string;
  sources: SourceRef[];
};

type MockEdge = { src: string; dst: string; type: Exclude<KbRelationType, "part_of">; description: string | null; sourceItemIds: string[] };

type KbTrash = { trashId: string; entries: MockEntry[]; edges: MockEdge[]; reparented: Array<{ id: string; parentId: string | null }>; ignored: string[] };

const CATEGORIES = [
  { id: "cat-retrieval", name: "检索", description: "召回、排序与索引" },
  { id: "cat-agent", name: "Agent 框架", description: "Agent 编排、状态与人机协作" },
  { id: "cat-llm", name: "大模型基础", description: "Transformer 与注意力机制" }
];

/** Notes placed in a KB trash snapshot; `restoreTrash` puts it back into `state.notes`, which marks the trash as restored (vs. purged). */
const RESTORE_SENTINEL = "kb-trash-sentinel:";

function at(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 8, day, hour, minute)).toISOString();
}

function entry(partial: Partial<MockEntry> & Pick<MockEntry, "id" | "name" | "kind" | "categoryId" | "summary" | "bodyMarkdown">): MockEntry {
  const mastery = partial.mastery ?? null;
  return {
    aliases: [],
    parentId: null,
    mastery,
    autoMastery: mastery,
    masterySource: "auto",
    userEdited: false,
    dirty: false,
    stale: false,
    patchCount: 1,
    completeness: { covered: ["定义"], missing: [] },
    updatedAt: at(30, 15, 4),
    sources: [],
    ...partial
  };
}

function createEntries(): MockEntry[] {
  return [
    entry({
      id: "kb-rerank",
      name: "重排",
      aliases: ["Rerank", "精排"],
      kind: "concept",
      categoryId: "cat-retrieval",
      summary: "对召回阶段返回的候选做二次精排，用更重的模型换取更高的排序精度。",
      bodyMarkdown:
        "## 定义\n\n重排（Rerank）位于检索流水线的第二阶段：召回先用 ANN 索引在毫秒级拿到几百条候选，重排再用更重的模型对候选逐一打分。\n\n## 常见做法\n\n- **交叉编码器**：查询与文档拼接后联合编码，精度最高；\n- **LLM 打分**：直接让大模型给出相关性；\n- **规则融合**：按时间、来源权重调整分数。\n\n## 适用场景\n\n| 场景 | 是否需要重排 |\n| --- | --- |\n| 问答 / RAG | 强烈建议 |\n| 关键词搜索 | 视候选量而定 |",
      mastery: 0.55,
      patchCount: 3,
      completeness: { covered: ["定义", "常见做法", "适用场景"], missing: ["性能开销"] },
      sources: [
        { itemId: "item-p2", sourceKind: "community", evidence: [{ quote: "实践中最常见的组合是：双塔负责高召回率的粗筛，交叉编码器负责高精度的精排。" }] },
        {
          itemId: "item-q2",
          sourceKind: "ai_answer",
          evidence: [{ question: "向量召回和重排有什么区别？", quote: "重排阶段用更重的模型对候选逐一打分。", turnItemId: "item-q2" }]
        }
      ]
    }),
    entry({
      id: "kb-cross",
      name: "交叉编码器",
      aliases: ["Cross-Encoder"],
      kind: "model",
      categoryId: "cat-retrieval",
      parentId: "kb-rerank",
      summary: "把查询和文档拼接后送入同一个 Transformer，直接输出相关性分数。",
      bodyMarkdown:
        '## 定义\n\n交叉编码器（Cross-Encoder）把 `[CLS] query [SEP] doc` 拼接后一起编码，由分类头输出相关性分数 $s = \\sigma(W h_{[CLS]})$。\n\n## 用法\n\n```python\nfrom sentence_transformers import CrossEncoder\n\nmodel = CrossEncoder("BAAI/bge-reranker-base")\nscores = model.predict([(query, doc) for doc in candidates])\n```\n\n## 代价\n\n每个查询-文档对都要完整跑一遍模型，复杂度 $O(N)$，所以只对召回得到的少量候选使用。\n\n## 补充\n\n- 输入长度通常限制在 512 token；\n- 长文档需要先切块再取最高分。',
      mastery: 0.65,
      patchCount: KB_REWRITE_SUGGEST_PATCH_COUNT,
      completeness: { covered: ["定义", "用法", "代价"], missing: ["训练方式"] },
      updatedAt: at(30, 15, 4),
      sources: [
        { itemId: "item-p2", sourceKind: "community", evidence: [{ quote: "交叉编码器则把查询和文档拼接在一起送进同一个模型。" }] },
        {
          itemId: "item-q1",
          sourceKind: "ai_answer",
          evidence: [
            {
              question: "什么是交叉编码器？",
              quote: "交叉编码器（Cross-Encoder）把查询和文档拼接后一起送入 Transformer 编码，直接输出相关性分数。",
              turnItemId: "item-q1"
            }
          ]
        }
      ]
    }),
    entry({
      id: "kb-bge",
      name: "bge-reranker",
      aliases: ["BGE Reranker"],
      kind: "model",
      categoryId: "cat-retrieval",
      parentId: "kb-cross",
      summary: "智源开源的交叉编码器重排模型，中英文效果都不错。",
      bodyMarkdown:
        "## 定义\n\nBAAI 开源的交叉编码器重排模型，提供 base / large / v2-m3 等规格。\n\n## 选型\n\n- 中文场景优先 `bge-reranker-v2-m3`；\n- 延迟敏感时用 base。",
      mastery: 0.35,
      sources: [{ itemId: "item-p2", sourceKind: "community", evidence: [{ quote: "常用 bge-reranker、ms-marco-MiniLM。" }] }]
    }),
    entry({
      id: "kb-bi",
      name: "双塔模型",
      aliases: ["Bi-Encoder", "双编码器"],
      kind: "model",
      categoryId: "cat-retrieval",
      summary: "查询与文档分别编码成向量，文档向量可离线预计算。",
      bodyMarkdown:
        "## 定义\n\n双塔模型用两个（或共享参数的）编码器分别把查询和文档编码成向量，用余弦相似度 $\\cos(q, d)$ 衡量相关性。\n\n## 优缺点\n\n- 文档向量可离线批量计算，适合大规模召回；\n- 查询与文档之间没有细粒度交互，精度不如交叉编码器。",
      mastery: 0.5,
      sources: [{ itemId: "item-p2", sourceKind: "community", evidence: [{ quote: "双塔模型把查询和文档分别编码成向量，文档向量可以离线批量计算。" }] }]
    }),
    entry({
      id: "kb-bm25",
      name: "BM25",
      aliases: ["Okapi BM25"],
      kind: "algorithm",
      categoryId: "cat-retrieval",
      summary: "经典的词频-逆文档频率检索打分函数。",
      bodyMarkdown:
        "## 定义\n\n$$\n\\mathrm{score}(D, Q) = \\sum_{i=1}^{n} \\mathrm{IDF}(q_i) \\cdot \\frac{f(q_i, D)\\,(k_1 + 1)}{f(q_i, D) + k_1\\left(1 - b + b\\,\\frac{|D|}{\\mathrm{avgdl}}\\right)}\n$$\n\n## 我的理解\n\n混合检索时 BM25 分数要先归一化再和向量分数融合。",
      mastery: 0.75,
      autoMastery: 0.6,
      masterySource: "user",
      userEdited: true,
      dirty: true,
      patchCount: 2,
      updatedAt: at(29, 20, 40),
      sources: [{ itemId: "item-p4", sourceKind: "community", evidence: [{ quote: "BM25 是搜索引擎根据查询词与文档的相关性对文档进行排序的一种算法。" }] }]
    }),
    entry({
      id: "kb-hnsw",
      name: "HNSW",
      aliases: ["分层可导航小世界图"],
      kind: "algorithm",
      categoryId: "cat-retrieval",
      summary: "分层可导航小世界图索引，近似最近邻检索的主流方案。",
      bodyMarkdown:
        "## 定义\n\n多层图结构：高层稀疏用于快速定位，底层稠密用于精确搜索。\n\n## 关键参数\n\n- `M`：每个节点的邻居数；\n- `efConstruction`：建图时的候选队列长度。",
      mastery: 0.2,
      stale: true,
      completeness: { covered: ["定义"], missing: ["复杂度", "与 IVF 的对比"] }
    }),
    entry({
      id: "kb-hybrid",
      name: "混合检索",
      aliases: ["Hybrid Search"],
      kind: "method",
      categoryId: "cat-retrieval",
      summary: "同时使用关键词检索与向量检索，再把两路结果融合。",
      bodyMarkdown:
        "## 定义\n\n关键词检索（如 BM25）擅长专有名词，向量检索擅长语义改写，两者互补。\n\n## 融合方式\n\n1. 分数归一化后加权；\n2. 按排名融合（RRF）。",
      mastery: 0.42,
      sources: [
        {
          itemId: "item-q2",
          sourceKind: "ai_answer",
          evidence: [{ question: "向量召回和重排有什么区别？", quote: "召回负责粗筛，重排负责精排。", turnItemId: "item-q2" }]
        },
        { itemId: "item-p4", sourceKind: "community", evidence: [{ quote: "BM25 是搜索引擎根据查询词与文档的相关性对文档进行排序的一种算法。" }] }
      ]
    }),
    entry({
      id: "kb-rrf",
      name: "RRF 融合",
      aliases: ["Reciprocal Rank Fusion"],
      kind: "algorithm",
      categoryId: "cat-retrieval",
      parentId: "kb-hybrid",
      summary: "按各路结果中的排名倒数求和来融合多路检索结果。",
      bodyMarkdown:
        "## 公式\n\n$$\n\\mathrm{RRF}(d) = \\sum_{r \\in R} \\frac{1}{k + r(d)}\n$$\n\n其中 $k$ 通常取 60。\n\n## 优点\n\n不需要对不同检索器的分数做归一化。",
      mastery: 0.28,
      sources: [{ itemId: "item-p4", sourceKind: "community", evidence: [{ quote: "混合检索时 BM25 分数需要先归一化再和向量分数融合。" }] }]
    }),
    entry({
      id: "kb-langgraph",
      name: "LangGraph",
      kind: "concept",
      categoryId: "cat-agent",
      summary: "用有向图描述 Agent 流程的编排框架，内置状态持久化。",
      bodyMarkdown: "## 定义\n\nLangGraph 用节点 + 边描述 Agent 的执行流程，状态在节点之间传递。\n\n## 我的笔记\n\n适合需要循环、分支和人工介入的复杂流程。",
      mastery: 0.48,
      userEdited: true,
      completeness: null
    }),
    entry({
      id: "kb-checkpoint",
      name: "Checkpoint",
      aliases: ["检查点"],
      kind: "concept",
      categoryId: "cat-agent",
      parentId: "kb-langgraph",
      summary: "每一步执行后保存图状态，用于恢复、回放和人工介入。",
      bodyMarkdown:
        "## 定义\n\n每个超步（super-step）结束后把状态写入 checkpointer，可按 `thread_id` 恢复。\n\n```ts\nconst graph = builder.compile({ checkpointer: new MemorySaver() });\n```",
      mastery: 0.3,
      sources: [{ itemId: "item-p5", sourceKind: "repo", evidence: [{ quote: "rag-toolkit 提供文档切块、向量化、混合检索与重排的完整流水线。" }] }]
    }),
    entry({
      id: "kb-interrupt",
      name: "Interrupt",
      kind: "concept",
      categoryId: "cat-agent",
      parentId: "kb-checkpoint",
      summary: "在节点内暂停执行，等待外部输入后从检查点继续。",
      bodyMarkdown: "## 定义\n\n调用 `interrupt()` 抛出暂停信号，图状态保存在 checkpoint 中，外部用 `Command({ resume })` 继续。",
      mastery: 0.22,
      sources: [{ itemId: "item-p5", sourceKind: "repo", evidence: [{ quote: "提供文档切块、向量化、混合检索与重排的完整流水线。" }] }]
    }),
    entry({
      id: "kb-hitl",
      name: "Human-in-the-loop",
      aliases: ["HITL", "人机协作"],
      kind: "concept",
      categoryId: "cat-agent",
      summary: "Agent 执行中暂停等待人工确认或修改。",
      bodyMarkdown: "## 定义\n\n在关键步骤（如调用外部工具、写库）前暂停，由人确认、修改或拒绝。",
      mastery: null,
      autoMastery: null,
      patchCount: 0,
      sources: [{ itemId: "item-p5", sourceKind: "repo", evidence: [{ quote: "开箱即用的 RAG 工具集。" }] }]
    }),
    entry({
      id: "kb-react",
      name: "ReAct",
      aliases: ["Reason + Act"],
      kind: "paper",
      categoryId: "cat-agent",
      summary: "交替进行推理与行动的提示范式，Agent 的基础模式之一。",
      bodyMarkdown: "## 核心思想\n\n模型交替输出 `Thought → Action → Observation`，直到给出最终答案。",
      mastery: 0.6,
      sources: [{ itemId: "item-p5", sourceKind: "repo", evidence: [{ quote: "rag-toolkit 提供完整流水线。" }] }]
    }),
    entry({
      id: "kb-transformer",
      name: "Transformer",
      kind: "model",
      categoryId: "cat-llm",
      summary: "完全基于注意力机制的序列建模架构。",
      bodyMarkdown: "## 结构\n\n- 编码器 / 解码器堆叠；\n- 每层包含多头自注意力与前馈网络；\n- 残差连接 + LayerNorm。",
      mastery: 0.7,
      sources: [
        {
          itemId: "item-q1",
          sourceKind: "ai_answer",
          evidence: [{ question: "什么是交叉编码器？", quote: "把查询和文档拼接后一起送入 Transformer 编码。", turnItemId: "item-q1" }]
        }
      ]
    }),
    entry({
      id: "kb-attn",
      name: "自注意力",
      aliases: ["Self-Attention", "Scaled Dot-Product Attention"],
      kind: "algorithm",
      categoryId: "cat-llm",
      parentId: "kb-transformer",
      summary: "序列中每个位置对所有位置加权求和，权重由 Q、K 的相似度决定。",
      bodyMarkdown:
        "## 公式\n\n$$\n\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V\n$$\n\n除以 $\\sqrt{d_k}$ 是为了防止点积过大导致 softmax 梯度消失。",
      mastery: 0.58,
      sources: [
        {
          itemId: "item-q1",
          sourceKind: "ai_answer",
          evidence: [{ question: "什么是交叉编码器？", quote: "送入 Transformer 编码，直接输出相关性分数。", turnItemId: "item-q1" }]
        }
      ]
    }),
    entry({
      id: "kb-aiayn",
      name: "Attention Is All You Need",
      kind: "paper",
      categoryId: "cat-llm",
      summary: "2017 年提出 Transformer 的论文。",
      bodyMarkdown: "## 贡献\n\n- 提出 Transformer；\n- 用多头注意力替代 RNN，训练可并行。",
      mastery: 0.4,
      sources: [
        { itemId: "item-q1", sourceKind: "ai_answer", evidence: [{ question: "什么是交叉编码器？", quote: "Transformer 编码。", turnItemId: "item-q1" }] }
      ]
    }),
    entry({
      id: "kb-prompt-cache",
      name: "Prompt 缓存",
      aliases: ["Prompt Caching"],
      kind: "method",
      categoryId: null,
      summary: "复用相同前缀的 KV 缓存，降低长提示词的延迟与费用。",
      bodyMarkdown: "## 定义\n\n服务端缓存提示词前缀的 KV，相同前缀的后续请求直接复用。",
      mastery: 0.15,
      sources: [
        {
          itemId: "item-q2",
          sourceKind: "ai_answer",
          evidence: [{ question: "向量召回和重排有什么区别？", quote: "召回阶段使用 ANN 索引在毫秒级返回几百条候选。", turnItemId: "item-q2" }]
        }
      ]
    })
  ];
}

function createEdges(): MockEdge[] {
  return [
    {
      src: "kb-cross",
      dst: "kb-bi",
      type: "contrasts",
      description: "交叉编码器对查询-文档对联合编码，精度高但无法预计算；双塔分别编码、可离线建索引，速度快但交互弱。实践中双塔负责召回、交叉编码器负责精排。",
      sourceItemIds: ["item-p2"]
    },
    {
      src: "kb-bm25",
      dst: "kb-bi",
      type: "contrasts",
      description: "BM25 基于词频做精确匹配，擅长专有名词与罕见词；双塔基于语义向量，擅长同义改写。",
      sourceItemIds: ["item-p4"]
    },
    { src: "kb-attn", dst: "kb-cross", type: "prerequisite", description: null, sourceItemIds: ["item-q1"] },
    { src: "kb-bi", dst: "kb-rerank", type: "prerequisite", description: null, sourceItemIds: ["item-p2"] },
    { src: "kb-checkpoint", dst: "kb-hitl", type: "prerequisite", description: null, sourceItemIds: [] },
    { src: "kb-hnsw", dst: "kb-bi", type: "related", description: null, sourceItemIds: [] },
    { src: "kb-hybrid", dst: "kb-bm25", type: "related", description: null, sourceItemIds: ["item-p4"] },
    { src: "kb-react", dst: "kb-langgraph", type: "related", description: null, sourceItemIds: [] },
    { src: "kb-aiayn", dst: "kb-transformer", type: "related", description: null, sourceItemIds: ["item-q1"] }
  ];
}

let entries: MockEntry[] = createEntries();
let edges: MockEdge[] = createEdges();
let ignored: string[] = [];
let kbTrash: KbTrash[] = [];

export function resetMockKbState(): void {
  entries = createEntries();
  edges = createEdges();
  ignored = [];
  kbTrash = [];
}

/** Names written to `kb_ignore` by「不再收录」. */
export function getMockKbIgnored(): string[] {
  return [...ignored];
}

function liveItems(): MockItem[] {
  return getMockState().items.filter((item) => !item.deletedAt);
}

function liveSources(target: MockEntry): Array<SourceRef & { item: MockItem }> {
  const items = new Map(liveItems().map((item) => [item.id, item]));
  return target.sources.flatMap((source) => {
    const item = items.get(source.itemId);
    return item ? [{ ...source, item }] : [];
  });
}

function entryNotes(id: string): Note[] {
  return getMockState().notes.filter((note) => note.scope === "entry" && note.targetId === id);
}

/** Applies a restore done through the shared trash (`restoreTrash`) and forgets purged KB trash. */
function reconcileTrash(): void {
  const state = getMockState();
  for (const trash of [...kbTrash]) {
    const sentinel = state.notes.findIndex((note) => note.id === `${RESTORE_SENTINEL}${trash.trashId}`);
    if (sentinel >= 0) {
      state.notes.splice(sentinel, 1);
      entries.push(...trash.entries);
      edges.push(...trash.edges);
      for (const move of trash.reparented) {
        const child = entries.find((candidate) => candidate.id === move.id);
        if (child) child.parentId = move.parentId;
      }
      ignored = ignored.filter((name) => !trash.ignored.includes(name));
      kbTrash = kbTrash.filter((candidate) => candidate !== trash);
    } else if (!state.trash.some((candidate) => candidate.id === trash.trashId)) {
      kbTrash = kbTrash.filter((candidate) => candidate !== trash);
    }
  }
}

function toNode(target: MockEntry): KbTreeEntryNode {
  const sourceCount = liveSources(target).length;
  return {
    id: target.id,
    name: target.name,
    aliases: target.aliases,
    kind: target.kind,
    summary: target.summary,
    mastery: target.mastery,
    masterySource: target.masterySource,
    stale: target.stale,
    userEdited: target.userEdited,
    orphan: sourceCount === 0,
    sourceCount,
    children: entries.filter((child) => child.parentId === target.id).map(toNode)
  };
}

function categoryName(id: string | null): string | null {
  return CATEGORIES.find((category) => category.id === id)?.name ?? null;
}

function toFlat(target: MockEntry): KbFlatEntry {
  const node: Omit<KbTreeEntryNode, "children"> & { children?: unknown } = toNode(target);
  delete node.children;
  return { ...node, categoryId: target.categoryId, categoryName: categoryName(target.categoryId) };
}

function categoryNodes(): KbTreeCategoryNode[] {
  const groups: Array<{ id: string | null; name: string; description: string | null }> = [...CATEGORIES];
  if (entries.some((candidate) => candidate.categoryId === null)) groups.push({ id: null, name: "未归类", description: "整理时未能归入已有分类的词条" });
  return groups.map((category) => {
    const members = entries.filter((candidate) => candidate.categoryId === category.id);
    const scored = members.filter((candidate) => candidate.mastery !== null);
    const memberIds = new Set(members.map((candidate) => candidate.id));
    return {
      ...category,
      entryCount: members.length,
      avgMastery: scored.length ? scored.reduce((sum, candidate) => sum + (candidate.mastery ?? 0), 0) / scored.length : null,
      weakEntryCount: scored.filter((candidate) => (candidate.mastery ?? 0) < 0.4).length,
      children: members.filter((candidate) => !candidate.parentId || !memberIds.has(candidate.parentId)).map(toNode)
    };
  });
}

function findEntry(id: string): MockEntry {
  const found = entries.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`API 404: entry not found: ${id}`);
  return found;
}

function ancestorsOf(target: MockEntry): MockEntry[] {
  const chain: MockEntry[] = [];
  const seen = new Set<string>([target.id]);
  let parentId = target.parentId;
  while (parentId && !seen.has(parentId)) {
    const parent = entries.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    chain.unshift(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return chain;
}

function relationsOf(target: MockEntry): KbRelation[] {
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  const parent = target.parentId ? byId.get(target.parentId) : undefined;
  const result: KbRelation[] = [];
  if (parent) result.push({ id: parent.id, name: parent.name, type: "part_of", direction: "out", mastery: parent.mastery, description: null });
  for (const child of entries.filter((candidate) => candidate.parentId === target.id)) {
    result.push({ id: child.id, name: child.name, type: "part_of", direction: "in", mastery: child.mastery, description: null });
  }
  for (const edge of edges) {
    if (edge.src !== target.id && edge.dst !== target.id) continue;
    const other = byId.get(edge.src === target.id ? edge.dst : edge.src);
    if (!other) continue;
    result.push({
      id: other.id,
      name: other.name,
      type: edge.type,
      direction: edge.src === target.id ? "out" : "in",
      mastery: other.mastery,
      description: edge.description
    });
  }
  return result;
}

function detailOf(id: string) {
  const target = findEntry(id);
  const category = CATEGORIES.find((candidate) => candidate.id === target.categoryId) ?? null;
  const sources = liveSources(target);
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  const contrasts = edges
    .filter((edge) => edge.type === "contrasts" && edge.description && (edge.src === id || edge.dst === id))
    .flatMap((edge) => {
      const other = byId.get(edge.src === id ? edge.dst : edge.src);
      return other ? [{ entryId: other.id, name: other.name, description: edge.description ?? "", sourceItemIds: edge.sourceItemIds }] : [];
    });
  const faqs = sources
    .filter((source) => source.item.type === "conversation")
    .map((source) => ({ question: source.item.question ?? source.item.title, itemId: source.item.id, turnItemId: source.evidence[0]?.turnItemId ?? null }));

  return kbEntryDetailSchema.parse({
    id: target.id,
    name: target.name,
    aliases: target.aliases,
    kind: target.kind,
    categoryId: target.categoryId,
    categoryName: category?.name ?? null,
    breadcrumb: [
      { type: "category", id: category?.id ?? null, name: category?.name ?? "未归类" },
      ...ancestorsOf(target).map((ancestor) => ({ type: "entry", id: ancestor.id, name: ancestor.name })),
      { type: "entry", id: target.id, name: target.name }
    ],
    summary: target.summary,
    bodyMarkdown: target.bodyMarkdown,
    renderedSections: { contrasts, faqs },
    completeness: target.completeness,
    mastery: target.mastery,
    masterySource: target.masterySource,
    userEdited: target.userEdited,
    dirty: target.dirty,
    stale: target.stale,
    orphan: sources.length === 0,
    patchCount: target.patchCount,
    suggestRewrite: target.patchCount >= KB_REWRITE_SUGGEST_PATCH_COUNT,
    updatedAt: target.updatedAt,
    notes: entryNotes(id),
    sources: sources.map((source) => ({
      itemId: source.item.id,
      title: source.item.title,
      type: source.item.type,
      url: source.item.url,
      site: source.item.site,
      sourceKind: source.sourceKind,
      addedAt: source.item.capturedAt,
      evidence: source.evidence
    })),
    relations: relationsOf(target),
    sameCategory: entries
      .filter((candidate) => candidate.categoryId === target.categoryId && candidate.id !== target.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name, mastery: candidate.mastery }))
  });
}

/** Nearest ancestor that survives deleting `ids`. */
function survivingParent(target: MockEntry, ids: Set<string>): MockEntry | null {
  let parentId = target.parentId;
  while (parentId && ids.has(parentId)) parentId = entries.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  return parentId ? (entries.find((candidate) => candidate.id === parentId) ?? null) : null;
}

/* ---------- Hooks used by the mock organize pipeline ---------- */

export function mockKbEntryIds(filter: "all" | "pending" = "all"): string[] {
  reconcileTrash();
  return entries.filter((candidate) => filter === "all" || candidate.dirty || candidate.stale).map((candidate) => candidate.id);
}

export function mockKbEntryName(id: string): string {
  return entries.find((candidate) => candidate.id === id)?.name ?? id;
}

export function mockKbEntryBriefs(): Array<{ id: string; name: string; mastery: number | null }> {
  reconcileTrash();
  return entries.map((candidate) => ({ id: candidate.id, name: candidate.name, mastery: candidate.mastery }));
}

export function mockKbEntryNotes(ids: string[]): Note[] {
  return getMockState().notes.filter((note) => note.scope === "entry" && note.targetId !== null && ids.includes(note.targetId));
}

export function mockKbDirtyCount(): number {
  return entries.filter((candidate) => candidate.dirty).length;
}

/** Rewrites entries: `user_edited` bodies are kept and only get a「整理建议」section (07 ⑦). */
export function mockRewriteEntries(ids: string[], finishedAt: string): Array<{ entryId: string; name: string; change: "rewritten" }> {
  const now = finishedAt;
  return ids.flatMap((id) => {
    const target = entries.find((candidate) => candidate.id === id);
    if (!target) return [];
    if (target.userEdited && !target.bodyMarkdown.includes("## 整理建议")) {
      target.bodyMarkdown += "\n\n## 整理建议\n\n- （演示）来源中提到的要点已合并到上方，你手动编辑的内容未被覆盖。";
    }
    target.dirty = false;
    target.stale = false;
    target.patchCount = 0;
    target.updatedAt = now;
    if (target.masterySource === "auto" && target.mastery !== null) target.mastery = Math.min(1, target.mastery + 0.03);
    for (const note of entryNotes(id)) note.usedAt = now;
    return [{ entryId: id, name: target.name, change: "rewritten" as const }];
  });
}

/** Demo results for pending inbox items that have no related entry yet. */
const NEW_ENTRY_FROM_ITEM: Record<string, () => MockEntry> = {
  "item-p5": () =>
    entry({
      id: "kb-rag-pipeline",
      name: "RAG 流水线",
      aliases: ["RAG Pipeline"],
      kind: "method",
      categoryId: "cat-retrieval",
      summary: "文档切块 → 向量化 → 混合检索 → 重排 → 生成 的完整链路。",
      bodyMarkdown: "## 步骤\n\n1. 文档切块；\n2. 向量化并建索引；\n3. 混合检索召回；\n4. 重排；\n5. 拼接上下文交给大模型生成。",
      mastery: 0.25,
      patchCount: 0,
      sources: [{ itemId: "item-p5", sourceKind: "repo", evidence: [{ quote: "rag-toolkit 提供文档切块、向量化、混合检索与重排的完整流水线。" }] }]
    })
};

const REJECTED_ITEMS = new Set(["item-p3"]);

/** Integrates one inbox item into the KB; returns the decision and touched entries. */
export function mockIntegrateItem(
  item: MockItem,
  finishedAt: string
): { decision: "new" | "supplement" | "reject"; entries: Array<{ entryId: string; name: string; change: "created" | "supplemented" }> } {
  reconcileTrash();
  if (REJECTED_ITEMS.has(item.id)) return { decision: "reject", entries: [] };
  const related = entries.filter(
    (candidate) => item.relatedEntries.some((rel) => rel.id === candidate.id) || candidate.sources.some((s) => s.itemId === item.id)
  );
  if (related.length) {
    for (const target of related) {
      if (!target.sources.some((source) => source.itemId === item.id)) {
        target.sources.push({
          itemId: item.id,
          sourceKind: item.type === "conversation" ? "ai_answer" : "blog",
          evidence: [{ quote: (item.markdown ?? item.title).slice(0, 80) }]
        });
      }
      target.patchCount += 1;
      target.stale = false;
      target.updatedAt = finishedAt;
    }
    return { decision: "supplement", entries: related.map((target) => ({ entryId: target.id, name: target.name, change: "supplemented" as const })) };
  }
  const create = NEW_ENTRY_FROM_ITEM[item.id];
  if (create) {
    const created = create();
    if (ignored.includes(created.name)) return { decision: "reject", entries: [] };
    if (!entries.some((candidate) => candidate.id === created.id)) {
      created.updatedAt = finishedAt;
      entries.push(created);
      edges.push({ src: created.id, dst: "kb-rerank", type: "related", description: null, sourceItemIds: [item.id] });
    }
    item.relatedEntries = [...item.relatedEntries, { id: created.id, name: created.name, mastery: created.mastery }];
    return { decision: "new", entries: [{ entryId: created.id, name: created.name, change: "created" }] };
  }
  return { decision: "reject", entries: [] };
}

export const mockKbApi = {
  async getKbTree(rawQuery: Partial<KbTreeQuery> = {}) {
    reconcileTrash();
    const query = kbTreeQuerySchema.parse(rawQuery);
    if (!query.q && !query.kind) {
      return kbTreeResponseSchema.parse({ mode: "tree", categories: categoryNodes(), entries: [], total: entries.length });
    }
    const needle = query.q?.toLowerCase();
    const matched = entries
      .filter((candidate) => !query.kind || candidate.kind === query.kind)
      .filter((candidate) => !needle || [candidate.name, ...candidate.aliases].some((name) => name.toLowerCase().includes(needle)))
      .map(toFlat);
    return kbTreeResponseSchema.parse({ mode: "flat", categories: [], entries: matched, total: matched.length });
  },

  async getKbEntry(id: string) {
    reconcileTrash();
    return detailOf(id);
  },

  async patchKbEntry(id: string, patch: KbEntryPatch) {
    reconcileTrash();
    const body = kbEntryPatchSchema.parse(patch);
    const target = findEntry(id);
    if (body.bodyMarkdown !== undefined && body.bodyMarkdown !== target.bodyMarkdown) {
      target.bodyMarkdown = body.bodyMarkdown;
      target.userEdited = true;
      target.dirty = true;
      target.updatedAt = new Date().toISOString();
    }
    if (body.mastery !== undefined) {
      target.mastery = body.mastery === null ? target.autoMastery : body.mastery;
      target.masterySource = body.mastery === null ? "auto" : "user";
    }
    if (body.categoryId !== undefined) target.categoryId = body.categoryId;
    return detailOf(id);
  },

  async getKbDeleteImpact(ids: string[]) {
    reconcileTrash();
    const idSet = new Set(ids);
    const targets = entries.filter((candidate) => idSet.has(candidate.id));
    const children = entries.filter((candidate) => candidate.parentId && idSet.has(candidate.parentId) && !idSet.has(candidate.id));
    const partOf = targets.filter((candidate) => candidate.parentId).length + children.length;
    const otherEdges = edges.filter((edge) => idSet.has(edge.src) || idSet.has(edge.dst)).length;
    return kbDeleteImpactResponseSchema.parse({
      entries: targets.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      noteCount: mockKbEntryNotes(ids).length,
      relationCount: partOf + otherEdges,
      reparentedChildren: children.map((child) => {
        const parent = survivingParent(child, idSet);
        return { id: child.id, name: child.name, newParentId: parent?.id ?? null, newParentName: parent?.name ?? null };
      }),
      sourceItemCount: new Set(targets.flatMap((candidate) => liveSources(candidate).map((source) => source.itemId))).size
    });
  },

  async deleteKbEntries(requestBody: KbDeleteRequestInput) {
    reconcileTrash();
    const body = kbDeleteRequestSchema.parse(requestBody);
    const idSet = new Set(body.ids);
    const removed = entries.filter((candidate) => idSet.has(candidate.id));
    if (!removed.length) throw new Error("API 404: entries not found");
    const reparented: KbTrash["reparented"] = [];
    for (const child of entries) {
      if (!child.parentId || !idSet.has(child.parentId) || idSet.has(child.id)) continue;
      reparented.push({ id: child.id, parentId: child.parentId });
      child.parentId = survivingParent(child, idSet)?.id ?? null;
    }
    const removedEdges = edges.filter((edge) => idSet.has(edge.src) || idSet.has(edge.dst));
    entries = entries.filter((candidate) => !idSet.has(candidate.id));
    edges = edges.filter((edge) => !removedEdges.includes(edge));
    const newlyIgnored = body.ignore ? removed.map((candidate) => candidate.name).filter((name) => !ignored.includes(name)) : [];
    ignored.push(...newlyIgnored);

    const state = getMockState();
    const removedNotes = mockKbEntryNotes(body.ids);
    state.notes = state.notes.filter((note) => !removedNotes.includes(note));
    const now = new Date();
    const trashId = `trash-kb-${now.getTime()}`;
    const sentinel: Note = {
      id: `${RESTORE_SENTINEL}${trashId}`,
      scope: "entry",
      targetId: null,
      text: "",
      origin: "workbench",
      usedAt: null,
      createdAt: now.toISOString(),
      updatedAt: null
    };
    state.trash.unshift({
      id: trashId,
      kind: "entries",
      title: removed.length === 1 ? `知识点「${removed[0]?.name}」` : `${removed.length} 个知识点`,
      site: null,
      itemType: null,
      deletedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      removeFromKb: true,
      removedEntryCount: removed.length,
      itemIds: [],
      noteIds: removedNotes.map((note) => note.id),
      entryIds: removed.map((candidate) => candidate.id),
      snapshot: { items: [], notes: [...removedNotes, sentinel] }
    });
    kbTrash.push({ trashId, entries: removed, edges: removedEdges, reparented, ignored: newlyIgnored });
    return kbDeleteResponseSchema.parse({ trashId, deletedEntryCount: removed.length });
  }
};
