# 14 方案与实施计划（知识图谱 + 动态词条类型）

目标：在已有「整理 → 知识库（目录 + 词条）」上交付两件事：① 知识库右侧图谱可视化（08「后续（图谱）」转为本期）；② 词条类型由固定枚举改为「种子类型 + LLM 动态扩展」，可改名 / 合并。

## 范围

| 内容 | 本期 |
| --- | --- |
| `GET /v1/kb/graph`、知识库右侧图谱、关系类型筛选、选中点亮 / 变暗、分类成簇 | 做 |
| 图谱 ↔ 目录双向联动（点节点选中目录项；目录选中点亮节点）、双击节点进详情 | 做 |
| 词条详情「在知识库中定位」改为「在图谱中查看」 | 做 |
| 词条类型动态化：种子类型、LLM 复用优先 / 必要时新建、类型数上限 | 做 |
| 类型筛选改为动态列表（带词条数）、词条编辑可改类型、类型改名 / 合并 | 做 |
| 修复 prompt 类型与库枚举不一致（`tool` / `library` 被写成 `other`） | 做（随动态化消失） |
| 图谱内拖拽编辑关系、手动连边、合并节点、图谱导出 | 不做 |
| 基于图谱的对话检索（命中词条扩展一跳邻居） | 不做（后续，见文末） |
| 类型的视觉编码（形状 / 颜色） | 不做：颜色已表示掌握度，动态类型无法稳定映射形状；类型只在筛选、tooltip、预览卡片出现 |

## 选型结论

| # | 事项 | 结论 |
| --- | --- | --- |
| S12 | 知识抽取 | 维持自研 TS 流水线（不引入 GraphRAG / LightRAG 等 Python 框架） |
| S14 | 图谱可视化 | **Cytoscape.js `^3.34.3` + `cytoscape-fcose` `^2.2.0`**（复合节点按分类成簇；类选择器做点亮 / 变暗） |
| — | 图谱存储 | 维持 SQLite `kb_edges` + 递归 CTE（不引入图数据库） |
| S24（新） | 词条类型 | 种子类型 + LLM 动态扩展（方案 C）；`kb_entries.kind` 直接存中文类型名，不建类型表 |

## 现有可复用能力

| 能力 | 位置 |
| --- | --- |
| 词条 / 分类 / 掌握度读取 | `domains/kb/queries.ts`（`loadAliveEntries`、`loadCategories`、`loadMasterySignals`、`masteryOf`、`parseRelationType`） |
| 动态分类先例（复用优先、必要时新建） | `domains/organize/integrate.ts` `resolveCategory`；prompt 输入 `categories` |
| 名称归一化 | `domains/organize/normalize.ts` `normalizeEntryName` |
| 知识库 UI 状态（选中 / 预览 / 折叠） | `apps/workbench/src/stores/kb.ts` `useKbUiStore` |
| 预览面板 | `pages/kb/KbPreview.tsx` `KbPreviewPanel` |
| 掌握度颜色 / 关系分组 | `apps/workbench/src/lib/kb.ts` `masteryColor`、`RELATION_GROUPS` |
| 原型图谱（交互与图例参照） | `prototype/workbench/app.js` 455–533 行 |

---

## 方案 A：动态词条类型

### A1 存储

- `kb_entries.kind` 保持 `TEXT`，**直接存中文类型名**（如「概念」「评测指标」）。LLM 输出、筛选参数、对齐比较、界面展示都用同一个值，不需要 id ↔ 名称映射。
- 类型词表 = `SEED_KINDS` ∪ 存活词条中出现过的 `kind`（`SELECT DISTINCT`）。不建 `kb_kinds` 表：改名 / 合并都是 `UPDATE kb_entries SET kind`，没有词条的自建类型自然消失。
- 迁移 `005_kb_kinds.sql` 把旧英文代码转为中文名：

```sql
-- S24: entry kinds become free-form Chinese names (14 A1).
UPDATE kb_entries SET kind = CASE kind
  WHEN 'concept' THEN '概念' WHEN 'method' THEN '方法' WHEN 'algorithm' THEN '算法'
  WHEN 'model' THEN '模型' WHEN 'paper' THEN '论文' WHEN 'tool' THEN '工具'
  WHEN 'library' THEN '库与框架' WHEN 'pattern' THEN '设计模式' WHEN 'practice' THEN '最佳实践'
  ELSE '其他' END
WHERE kind IS NULL OR kind IN ('concept','method','algorithm','model','paper','tool','library','pattern','practice','other');
```

- 回收站快照里的旧代码在恢复时可能写回英文值：读侧 `normalizeKind` 同样走旧代码映射，无需改快照。

### A2 共享常量与解析（`packages/shared/src/api/kb.ts`）

```ts
export const SEED_KINDS = ["概念", "方法", "算法", "模型", "论文", "工具", "库与框架", "设计模式", "最佳实践", "其他"] as const;
export const OTHER_KIND = "其他";
export const MAX_KINDS = 20;
export const MAX_KIND_LENGTH = 8;
/** Legacy enum codes (pre-005 rows, trash snapshots, models answering in English). */
export const LEGACY_KIND_NAMES: Record<string, string> = {
  concept: "概念", method: "方法", algorithm: "算法", model: "模型", paper: "论文",
  tool: "工具", library: "库与框架", pattern: "设计模式", practice: "最佳实践", other: "其他"
};

export const kbEntryKindSchema = z.string().trim().min(1).max(MAX_KIND_LENGTH);
export type KbEntryKind = string;

export const kbKindSummarySchema = z.object({ name: z.string(), entryCount: z.number().int().nonnegative(), seed: z.boolean() });
export const kbKindsResponseSchema = z.object({ kinds: z.array(kbKindSummarySchema) });
/** Rename; when `to` already exists this merges `from` into it. */
export const kbKindRenameSchema = z.object({ from: kbEntryKindSchema, to: kbEntryKindSchema });
export const kbKindRenameResponseSchema = z.object({ updated: z.number().int().nonnegative() });
```

- `kbEntryPatchSchema` 增加 `kind: kbEntryKindSchema.optional()`。
- `KB_API` 增加 `kinds: "/v1/kb/kinds"`、`graph: "/v1/kb/graph"`。

### A3 写入侧解析 `resolveKind`（`domains/organize/kinds.ts`，新文件）

```ts
/** Map a model-proposed kind onto the vocabulary; new kinds allowed until MAX_KINDS. */
export function resolveKind(raw: string | null | undefined, vocabulary: readonly string[]): string {
  const name = raw?.trim() ?? "";
  if (!name) return OTHER_KIND;
  const legacy = LEGACY_KIND_NAMES[name.toLowerCase()];
  if (legacy) return legacy;
  const hit = vocabulary.find((kind) => normalizeEntryName(kind) === normalizeEntryName(name));
  if (hit) return hit;
  if ([...name].length > MAX_KIND_LENGTH || vocabulary.length >= MAX_KINDS) return OTHER_KIND;
  return name;
}

export function kindVocabulary(db: DatabaseSync): string[] {
  const used = (db.prepare("SELECT DISTINCT kind FROM kb_entries WHERE deleted_at IS NULL AND kind IS NOT NULL").all() as Array<{ kind: string }>).map((row) => row.kind);
  return [...new Set([...SEED_KINDS, ...used])];
}
```

- `integrate.ts`：删除 `toKbKind` / `KB_KINDS`；`integrateExtraction` 开头取一次 `kindVocabulary(db)`，每个 concept 先 `resolveKind`，**把解析后的值**同时传给 `decideAlignment`（`kind` 比较才在同一命名空间）和 `insertEntry`；新建类型后追加进本单元的词表，保证上限对同一单元内的多个新类型也生效。
- `domains/kb/queries.ts` `normalizeKind(kind)`：`LEGACY_KIND_NAMES` 命中则映射，空值返回 `OTHER_KIND`，其余原样返回。

### A4 Prompt

- `schemas.draft.ts`：删除 `ENTRY_KINDS`；输入增加 `kinds: z.array(z.string())`；`concept.kind` 改为 `z.string().describe("优先取自 kinds；都不合适时给新类型名")`；`entryRewriteInputSchema.entry.kind` 改为 `z.string()`。
- `process.ts` 组装输入：`kinds: kindVocabulary(ctx.db)`；`related_entries[].kind` 用 `normalizeKind(entry.kind)`。
- `rewrite.ts`：删除 `promptKind`，直接用 `normalizeKind(entry.kind)`。
- `knowledge-processing.ts`：`PROMPT_VERSION` 升到 `knowledge_processing@2`；「新词条」一节增加：

```text
- kind：词条的性质（是什么东西），不是主题。优先从 kinds 中选择；都明显不合适时才给新类型名：2–6 字中文名词（如「评测指标」「数据集」），不得与 kinds 中已有类型同义，不得用主题名（主题写在 category）。
```

  SYSTEM 首段「每个词条是一个概念 / 方法 / 工具」改为「每个词条是一个知识点」。

### A5 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1/kb/kinds` | 词表与各类型存活词条数；排序：种子类型按 `SEED_KINDS` 顺序在前，其余按词条数降序、名称升序 |
| `PATCH /v1/kb/kinds` | `{from, to}` 改名；`to` 已存在即合并。`UPDATE kb_entries SET kind = ?, updated_at = ? WHERE kind = ? AND deleted_at IS NULL`；`from === to` 返回 `updated: 0` |
| `GET /v1/kb/tree?kind=` | `kind` 改为任意字符串，逻辑不变（`tree.ts` 比较 `normalizeKind` 后的值） |
| `PATCH /v1/kb/entries/:id` | 支持 `kind`（`edit.ts` 写入，与 `categoryId` 一致不置 `user_edited`；整理流程只在新建时写 `kind`，不会覆盖用户修改） |

改名 / 合并不触发整理与检索索引重建（`kind` 不进检索文本）。

### A6 前端

- `lib/kb.ts`：删除 `KIND_LABEL`、`FILTER_KINDS`，界面直接显示 `entry.kind`（`KbPreview`、`KbEntryPage`）。
- `routes/router.tsx`：搜索参数 `kind: z.string().trim().min(1).optional().catch(undefined)`。
- 类型筛选：`useQuery(["kb", "kinds"], api.getKbKinds)`，选项显示「概念（12）」；只列 `entryCount > 0` 的类型；下拉末尾一项「管理类型…」打开 `KbKindsDialog`。
- `KbKindsDialog.tsx`（Radix Dialog）：列出类型、词条数；每行「改名」变为输入框，回车提交；输入已存在的类型名时提示「将合并到『X』，共 n 个词条」，确认后提交。成功后 `invalidateQueries({ queryKey: ["kb"] })`；当前筛选的类型被改名时同步更新路由参数。
- 词条编辑态：头部类型标签变为 `<input list="kb-kind-options">` + `<datalist>`（选已有或直接输入新类型，原生控件，不引组件库）；随「保存」一起提交。
- mock：`api/mock/kb.ts` 种子数据 `kind` 改为中文名；新增 `getKbKinds`、`renameKbKind`；`api/real/kb.ts` 同步新增。

---

## 方案 B：知识图谱

### B1 接口 `GET /v1/kb/graph`（`domains/kb/graph.ts`，新文件）

```ts
export const kbGraphResponseSchema = z.object({
  categories: z.array(z.object({ id: z.string(), name: z.string() })),
  nodes: z.array(z.object({
    id: z.string(), name: z.string(), kind: kbEntryKindSchema, categoryId: z.string().nullable(),
    mastery: mastery.nullable(), stale: z.boolean(), orphan: z.boolean()
  })),
  edges: z.array(z.object({ src: z.string(), dst: z.string(), type: kbRelationTypeSchema }))
});
```

- 节点：`loadAliveEntries` + `loadMasterySignals` / `masteryOf`；`categoryId` 不在 `loadCategories` 中时置 `null`；`orphan` 规则与 `tree.ts` 相同（`orphan` 或来源数为 0）。
- 边：`SELECT src, dst, type FROM kb_edges`，仅保留两端都存活、`src <> dst`、`parseRelationType` 合法的边。
- 分类只返回有节点的分类。规模按数百节点设计，一次全量返回，不分页。

### B2 组件

- 依赖：`apps/workbench` 增加 `cytoscape@^3.34.3`、`cytoscape-fcose@^2.2.0`，dev 增加 `@types/cytoscape-fcose@^2.2.5`（cytoscape 自带类型）。
- `lib/kb-graph.ts`（纯函数，可单测）：
  - `toElements(graph)`：分类 → 复合节点 `cat:<id>`（无分类节点不设 parent）；词条 → 节点 `data: { id, label: name, parent, size: 28 + (mastery ?? 0) * 28, color: masteryColor(mastery) }`；边 id `${src}|${dst}|${type}`，`classes: type`。
  - `focusSets(graph, focus)`：返回 `{ nodes: Set<string>, edges: Set<string> } | null`（`null` = 不变暗）。规则沿用原型：
    - 单个词条：自身 + 直接邻居点亮；仅与它相连的边点亮；
    - `cat:<id>`：该分类全部词条点亮；两端都点亮的边点亮；
    - 多选（`checked` 非空，优先级最高）：已选词条点亮；两端都已选的边点亮；
    - 无焦点：`null`。
  - `graphSignature(graph)`：节点 id + 边 id 排序后拼接，用于判断是否需要重新布局。
- `pages/kb/KbGraph.tsx`：
  - `cytoscape.use(fcose)` 模块级注册一次；`useRef` 持有实例，卸载时 `cy.destroy()`。
  - **只在 `graphSignature` 变化时**重建元素并运行 `fcose`（`animate: false`、`nodeDimensionsIncludeLabels: true`、`packComponents: true`）；焦点和筛选变化只切换 class，不重新布局。
  - 样式表（颜色取原型图例）：节点 `background-color: data(color)`、`width/height: data(size)`、`label: data(label)`、`min-zoomed-font-size: 8`（缩小时自动隐藏标签）；复合节点浅底圆角 + 分类名；边 `part_of #4c6ef5`、`prerequisite #f08c00`、`related #c3c9d1`、`contrasts #e03131 dashed`，`target-arrow-shape: triangle`，`curve-style: bezier`；`.dim { opacity: 0.15 }`、`.filtered { display: none }`、`.focus` 节点加描边。
  - 事件：单击词条节点 → `onSelect(id)`；单击复合节点 → `onSelect("cat:<id>")`；单击空白 → `onSelect(null)`；双击词条 → `onOpen(id)`。
  - 外部焦点为单个词条时 `cy.animate({ center: { eles: node } })`，不改缩放。
- 关系筛选：`useKbUiStore` 增加 `graphRelation: KbRelationType | "all"` 与 `setGraphRelation`；图上方 chips「全部关系 / 属于 / 前置 / 相关 / 对比」，未选中类型的边加 `.filtered`。

### B3 页面布局与联动（`KbPage.tsx`）

- `.kb-side` 改为纵向：关系 chips → 图谱卡片（`flex: 1; min-height: 320px`）→ `KbPreviewPanel`（`max-height: 40%`，内部滚动）。页面仍为视口高度，不出现整页滚动（08「页面」）。
- 图谱 → 目录：`onSelect(id)` 调用 `setPreview(id)`，并 `expand(categoryKey(categoryId))` + `scrollIntoView` 到对应目录行（复用现有 `selectedId` effect 的逻辑，抽成 `revealInTree(id)`）。
- 目录 → 图谱：图谱焦点取 `effectivePreview` 与 `checkedIds`，与预览面板同源，无需新状态。
- 筛选 / 搜索中：图谱仍显示全量，把命中词条作为多选焦点点亮（`focus = filtered.data.entries.map(e => e.id)`），不在图里删节点。
- 空态：无词条显示「知识库还是空的」；有词条无边时照常显示孤立节点。
- `KbEntryPage`：「在知识库中定位」改为「在图谱中查看」，行为不变（跳 `/wiki?selected=<id>`，图谱随 `selectedId` 点亮并居中）。

---

## 里程碑

```text
G1 类型·后端 ──→ G2 类型·前端 ──┐
G3 图谱接口 ──→ G4 图谱组件 ──→ G5 布局与联动 ──┴→ G6 联调与文档
```

G1 与 G3 互不依赖，可以并行。

| 里程碑 | 内容 | 预估（人日） | 状态 |
| --- | --- | --- | --- |
| G1 | 动态类型后端：shared 契约、迁移 005、`resolveKind`、prompt v2、对齐 / 重写、`/v1/kb/kinds` | 1.5 | 完成 |
| G2 | 动态类型前端：动态筛选、类型显示、编辑改类型、`KbKindsDialog`、mock | 1 | 完成 |
| G3 | 图谱接口：`kbGraphResponseSchema`、`graph.ts`、路由、real / mock API | 0.5 | 完成 |
| G4 | 图谱组件：依赖、`kb-graph.ts` 纯函数、`KbGraph.tsx`、样式 | 1.5 | 完成 |
| G5 | 布局与联动：右栏重排、关系筛选、双向联动、筛选点亮、详情入口改名 | 1 | 完成 |
| G6 | 真实模型联调、类型收敛检查、文档同步 | 0.5 | 文档已同步、mock 浏览器验证通过；真实模型联调与 Playwright 待补 |
| 合计 | | 约 6 | |

### G1 动态类型后端

文件：`packages/shared/src/api/kb.ts`；`services/local-ingestion/src/migrations/005_kb_kinds.sql`（新）；`src/domains/organize/kinds.ts`（新）、`integrate.ts`、`process.ts`、`rewrite.ts`；`src/ai/prompts/schemas.draft.ts`、`knowledge-processing.ts`；`src/domains/kb/queries.ts`、`edit.ts`、`kinds.ts`（新：`listKbKinds`、`renameKbKind`）、`index.ts`；`src/http/routes/kb.ts`；测试夹具中 `kind: "concept"` 保持不动（由旧代码映射覆盖）。

验收（`node --test`，内存 SQLite）：
- `test/organize/kinds.test.ts`：`resolveKind` 覆盖：空值 → 其他；`"tool"` → 工具；`"概念 "` → 概念；归一化后同名（大小写 / 全半角）命中已有；新名在上限内原样返回；词表满 20 → 其他；超长 → 其他。
- 迁移：在插入旧代码数据的库上执行 005 后，`concept` / `library` / `NULL` 分别变为「概念」「库与框架」「其他」，已是中文的值不变。
- `integrate`：LLM 输出 `kind: "评测指标"` 时新建词条 `kind = 评测指标`；同一单元两个新类型在词表剩 1 个名额时第二个落为「其他」；`kind: "tool"` 写入「工具」（回归旧 bug）。
- 对齐：已有词条 `kind = 概念`，embedding 命中、LLM 给 `"concept"` → 判为同类型并对齐（验证比较发生在解析之后）。
- `test/kb/kb-routes.test.ts`：`GET /v1/kb/kinds` 排序与计数（含已删除词条不计）；`PATCH /v1/kb/kinds` 改名、合并到已有类型、`from === to`、非法输入 422；`GET /v1/kb/tree?kind=评测指标` 返回平铺结果；`PATCH /v1/kb/entries/:id {kind}` 生效，`user_edited` 不变。
- `npm run check`、`npm test` 通过。

### G2 动态类型前端

文件：`apps/workbench/src/lib/kb.ts`、`routes/router.tsx`、`pages/kb/KbPage.tsx`、`KbPreview.tsx`、`KbEntryPage.tsx`、`KbKindsDialog.tsx`（新）、`api/real/kb.ts`、`api/mock/kb.ts`。

验收（Vitest，mock API）：
- `KbPage.test.tsx`：类型下拉选项来自 `getKbKinds`，显示词条数，不含 0 词条的类型；选择后 `onFilterChange` 收到中文类型名。
- `KbKindsDialog`：改名后列表与目录标签更新；输入已有名称出现合并提示，确认后原类型消失、目标计数相加。
- `KbEntryPage.test.tsx`：编辑态可从 datalist 选择或输入新类型，保存后头部标签更新。
- `contracts.test.ts`：mock 的 `getKbKinds` / `renameKbKind` 返回值通过 shared schema 校验。

### G3 图谱接口

文件：`packages/shared/src/api/kb.ts`（`kbGraphResponseSchema`、`KbGraphResponse`）；`services/local-ingestion/src/domains/kb/graph.ts`（新）、`index.ts`；`src/http/routes/kb.ts`（`api.get("/kb/graph")`）；`apps/workbench/src/api/real/kb.ts`、`api/mock/kb.ts`（`getKbGraph`，由 mock 的 entries / edges 生成）。

验收：
- `test/kb/kb-routes.test.ts`：已删除词条及其边不返回；非法关系类型、自环不返回；无分类词条 `categoryId = null`；指向已删除分类的词条 `categoryId = null`；掌握度与 `/v1/kb/tree` 一致。
- `contracts.test.ts`：mock `getKbGraph` 通过 schema 校验。

### G4 图谱组件

文件：`apps/workbench/package.json`；`src/lib/kb-graph.ts`（新）、`src/lib/kb-graph.test.ts`（新）；`src/pages/kb/KbGraph.tsx`（新）；`src/styles/kb.css`。

验收：
- `kb-graph.test.ts`：`focusSets` 四种焦点规则各一例（单词条含入边 / 出边邻居；分类只点亮分类内的边；多选优先于单选；无焦点返回 `null`）；`toElements` 复合节点 parent 正确、无分类节点无 parent、边 id 唯一；`graphSignature` 对节点顺序不敏感、增删边时变化。
- jsdom 没有 canvas，`KbGraph` 不在 Vitest 中渲染；页面测试 `vi.mock("./KbGraph")` 替换为记录 props 的桩组件。真实渲染由 G6 的 Playwright 覆盖。
- `npm run dev` 用 mock 数据人工核对：分类成簇、颜色 / 线型与原型图例一致、缩小时标签隐藏、焦点切换不触发重新布局。

### G5 布局与联动

文件：`src/pages/kb/KbPage.tsx`、`src/stores/kb.ts`、`src/pages/kb/KbEntryPage.tsx`、`src/styles/kb.css`、`src/pages/kb/KbPage.test.tsx`。

验收（Vitest，`KbGraph` 桩）：
- 悬停 / 选中目录词条 → 桩收到的 `focus` 为该词条；勾选多个 → `focus` 为多选集合；悬停分类行 → `cat:<id>`。
- 桩触发 `onSelect("kb-cross")` → 预览面板显示该词条，所在分类展开且目录行带选中样式；`onOpen` → `navigate` 到详情。
- 关系 chips 切换 → 桩收到的 `relation` 变化；状态在切换模块后保留（`useKbUiStore`）。
- 搜索中 → 桩收到命中词条集合作为焦点。
- 词条详情按钮文案为「在图谱中查看」。

### G6 联调与文档

- 真实模型（知识处理任务当前配置的模型 + Ollama `qwen2.5:7b` 各一次）：对 20 条以上已有收集条目执行「知识库 · 全量」重新整理，检查：类型总数 ≤ 20、无同义重复类型（如「工具」与「开发工具」）、`其他` 占比明显低于当前 4/6。不达标则调整 A4 的提示词措辞或下调 `MAX_KINDS`，结论写回 07。
- Playwright（`scripts/` 现有 e2e 方式）：打开知识库 → 图谱 canvas 渲染、节点数与 `/v1/kb/graph` 一致 → 点击目录词条后截图确认点亮 → 双击节点进入详情。
- 文档：00「本期范围」移除「知识图谱可视化」不做项，S14 结论改为 Cytoscape.js + fcose，新增 S24；07 知识处理输入 / 输出补充 `kinds` 与 `kind` 规则；08 去掉「本期不做」说明，类型筛选改为动态列表，补充 `GET /v1/kb/graph`、`/v1/kb/kinds` 两行 API。

## 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| LLM 造出同义 / 主题式类型（「RAG 技术」） | 筛选列表变乱 | prompt 明确「性质不是主题」+ 复用优先；归一化去重；上限 20 兜底；用户可合并 |
| 模型仍输出英文代码 | 出现英文类型 | `LEGACY_KIND_NAMES` 映射；未知英文按普通新类型处理，G6 抽查 |
| prompt 版本变更导致整理缓存失效 | 下次整理重复调用 | `PROMPT_VERSION` 升级是预期行为；只影响重新整理的条目 |
| 每次数据刷新都重新布局 | 节点跳动 | 只在 `graphSignature` 变化时运行 fcose |
| 节点多时标签重叠 | 图难读 | `min-zoomed-font-size` 缩小隐藏标签；关系筛选；分类成簇 |
| jsdom 无 canvas | 组件无法单测 | 逻辑全放 `kb-graph.ts` 纯函数单测；渲染走 Playwright |

## 后续（不在本期）

- 对话检索接入图谱：`search_knowledge` 命中词条后沿 `kb_edges` 扩展一跳邻居，把邻居摘要并入上下文（GraphRAG 局部检索思路，不引框架）。
- 节点数超过约 2000 时评估切换 Sigma.js（WebGL）。

## 完成标准

- `npm run check`、`npm test`、G6 的 Playwright 用例通过。
- 本文「范围」中标为「做」的各项可用；G6 的类型收敛检查达标并写回 07；00 / 07 / 08 已同步。
