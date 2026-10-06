# 原文为主的整理 Implementation Plan

> 执行方式：4 个子 agent 并行（任务 A1 / A2 / B / C），文件所有权互不重叠；最后由主 agent 统一清理、跑全量测试、更新旧文档。工作区有大量用户未提交改动：**不要 git commit / stash / reset / checkout**，只编辑自己负责的文件。

**Goal:** 实现 `docs/tech-solution/17-organize-verbatim.md`。

**Spec:** `docs/tech-solution/17-organize-verbatim.md`（权威；本计划与之冲突时以 spec 为准）

## 已就绪的底座（主 agent 已完成，直接使用，不要改）

- `packages/shared/src/kb-sections.ts`（已从 `@study-studio/shared` 导出）：
  - `type KbSection = { id: string | null; heading: string | null; sourceItemIds: string[]; markdown: string }`
  - `parseSections(body): KbSection[]`、`serializeSections(sections): string`、`stripSectionMarkers(body): string`
  - `demoteHeadings(markdown): string`、`newSectionId(): string`
  - `appendSections(body, [{ heading, markdown, sourceItemIds }]): { body, ids }`（自动降级片段内标题、生成标记）
  - `attachSectionSources(body, sectionId, itemIds): string | null`
  - `removeSectionSource(body, itemId): { body, removedSectionIds }`
  - 测试：`packages/shared/test/kb-sections.test.ts`
- 共享类型：`noteSummarySchema.anchor?: string | null`；`createNoteRequestSchema.anchor?: string | null`；`kbEntrySectionSchema { id, heading, sourceItemIds }`；`kbEntryDetailSchema.sections: KbEntrySection[]`。
- 迁移 `services/local-ingestion/src/migrations/008_notes_anchor.sql`：`notes.anchor TEXT`。

## Global Constraints

- 中文 UI 文案与提示词；技术名词保留英文。代码风格、注释密度跟随周边代码。
- 测试命令：后端 `node --import tsx --test <文件>`（仓库根目录）；前端 `cd apps/workbench && npx vitest run <文件>`；类型检查 `npx tsc -p services/local-ingestion` / `cd apps/workbench && npx tsc -p tsconfig.json --noEmit`。
- 不新增依赖。
- 跨任务的公共函数签名不得改动：`integrate.ts` 的 `writeResults(db, items, record, runId, now, targetEntryIds)`、`recordRejection`、`ResultRecord`、`IntegrationContext`；`rewrite.ts` 的 `rewriteEntry(db, llm, entryId, trigger, requirement, now): Promise<RewriteOutcome>` 以及 `markStaleEntries` / `staleEntryIds` 导出（实现可变）。
- 整理指令只来自：条目备注（`scope='item'`）、模糊备注（`scope='fuzzy'`）、整理要求（`origin='organize_requirement'`）。词条备注（`scope='entry'`）不进入任何整理提示词。

---

### Task A1：自动整理流水线（抽取 → 校验 → 对齐 → 写入）

**拥有文件：** `services/local-ingestion/src/ai/prompts/knowledge-extract.ts`（重写）、新建 `ai/prompts/knowledge-align.ts`、`ai/prompts/schemas.draft.ts`、`ai/prompts/index.ts` 中 `knowledge_*` 键（不要动 `entry_rewrite` 键）、`domains/organize/process.ts`、`domains/organize/coverage.ts`（改为 V1/V2 校验，可改名 `verify.ts`）、`domains/organize/pipeline.ts`、`domains/organize/integrate.ts`、`domains/organize/chunk.ts`（抽取不再分块；`annotateExposure` 若仍被用可保留）、`test/organize/**`（pipeline / process / helpers / fixtures `test/fixtures/llm/**` 及 `scripts/record-llm-fixtures.ts` 中受影响部分）、`apps/workbench/src/api/mock/organize.ts` 中 trace 步骤（`knowledge_triage`/`knowledge_compose` → `knowledge_extract`/`knowledge_align`）。

**要求（细节见 spec「自动整理流程」「词条数据 · 写入」）：**
1. 删除 triage 调用；`processUnit` 改为：`knowledge_extract`（全文一次，`task: knowledge_processing`）→ V1 → 概念召回（复用现有 `candidateEntries` 思路）→ `knowledge_align`（`task: knowledge_processing`）→ V2 → 组装结果。trace step 名：`knowledge_extract`、`knowledge_align`、`processing_result`。
2. extract 输入 `instructions`：条目备注、模糊备注（`fuzzyNotesNear`）、整理要求，各自标注类别。learning judge 的 topic / learning_goal 不传入。
3. V1：bigram 原文一致性阈值常量 `VERBATIM_MIN_RATIO = 0.85`（`summarized=true` 跳过）；章节完整性（正文 ≥ 50 字的原文章节需被片段 `source_section` 引用或在 `removed` 中）；问题 → feedback 重试 1 次取问题更少者；剩余遗漏写入 raw `missing_sections`。
4. V2：每片段恰好分配一次；entry 只能是候选/邻居 id 或 `new_entries` key；`covered_by` 必须是该词条已有章节 id（用 `parseSections` 取）；问题 → 重试 1 次，仍失败抛错（单元 failed）。
5. 决定推导：无片段 → reject(low_information)（adopt → 抛错）；全部 covered → duplicate；有新词条 → new；否则 supplement。
6. 写入（integrate.ts）：新词条正文 = `appendSections("", 片段)`；已有词条 = `appendSections(body, 片段)` 且 `patch_count+1`；`covered_by` = `attachSectionSources`；`kb_entry_sources.evidence` 存 `[{ section_id, heading }]`（`quote` 字段写 heading 以兼容旧读取）；关系、别名、ignored、kind 解析沿用现有逻辑（`decideAlignment` 等）。user_edited 词条同样追加章节。条目备注不再复制到词条（若现有逻辑有派生 entry note，删除）。
7. `PROCESSING_PROMPT_VERSION` 更新为 `organize@4(knowledge_extract@2+knowledge_align@1)`。
8. 测试：更新 pipeline 测试与 replay fixtures；新增用例——长问答（构造多章节回答）所有章节进入片段；改写片段触发重试；条目备注「剔除」进入 `removed`；第二篇来源 covered → 只追加来源。不要保留对已删除行为（triage、compose、分块）的断言。

### Task A2：整理结构 + 来源删除级联 + 索引去标记

**拥有文件：** `domains/organize/rewrite.ts`、`ai/prompts/entry-rewrite.ts`（改为整理结构提示词，可改名 `entry-restructure.ts`，同时更新 `ai/prompts/index.ts` 的 `entry_rewrite` 键——只动这个键）、`schemas.draft.ts` 中 entry rewrite 相关 schema（若在该文件，只改这部分；与 A1 同文件，用精确 StrReplace，不要整体重写文件）、`domains/inbox/delete.ts`（`removeFromKb`）、`domains/trash/items.ts`（恢复时正文快照）、`domains/kb/delete.ts`（如涉及）、`domains/organize/kb-index.ts`（索引正文前 `stripSectionMarkers`）、`domains/chat/**` 中读取词条正文给模型的地方（去标记）、对应测试 `test/organize/rewrite*.test.ts`、`test/inbox/**` / `test/trash/**` 中受影响用例。

**要求：**
1. `rewriteEntry` 保持签名，实现改为「整理结构」：输入章节列表（section_id、heading、markdown、sources；无标记章节给临时 id `u_<index>` 且不可合并删除）；输出 `{ order: string[], headings: Record<id,string>, merge: [{ keep, drop: string[] }], summary }`；代码按 id 重拼、文字不变，合并时来源并入保留章节、被并章节的锚定备注改锚到保留章节；校验 order 覆盖所有 id，否则重试 1 次，仍失败不改正文。user_edited 词条也可整理结构（不改文字）。`patch_count` 归 0。词条备注不进入提示词。
2. `stale` 不再由来源删除触发；`markStaleEntries` / `staleEntryIds` 保留导出但 `markStaleEntries` 改为不标记（返回 0）或只处理遗留数据——以 pipeline 不再因来源删除触发重写为准。
3. 删除来源条目（`removeFromKb`）：对受影响词条执行 `removeSectionSource`；被删章节上的锚定备注 `anchor = NULL`；词条无剩余内容（无章节且无非空手写内容）时按现有规则删除词条，否则更新正文；回收站快照包含删除前正文，恢复时还原正文与备注锚点。
4. 搜索 / 向量索引与 chat 读取词条正文时使用 `stripSectionMarkers`。
5. 测试覆盖：删除单来源章节消失、共享章节去来源；恢复还原；整理结构重排与合并不改文字。

### Task B：Agent 整理（LLM Wiki 模式）

**拥有文件：** `domains/agent/**`（`tools.ts`、`submit.ts`→写入工具实现、`guidelines.ts`、`skill.ts`、`units.ts`、`session.ts` 等）、`skills/organize-kb/SKILL.md`、`skills/INSTALL.md`（如涉及）、`packages/shared/src/api/agent.ts`、`packages/cli/**` 中与 skill 版本 / 工具名相关处、`test/agent/**`。

**要求（见 spec「Agent 整理」）：**
1. `AGENT_SKILL_VERSION = 3`；skill 流程：逐篇 `get_unit`（返回全文 `text` 或 `turns`，不再 `chunks`）→ `search_kb` / `get_entry` → 向用户汇报方案并等待确认 → 写入 → 下一篇；`SKILL.md` 与 `skill.ts` 内容一致（有测试强制）。
2. `get_guidelines` 改为 LLM Wiki 写作规范（不再拼接 knowledge_triage / compose 的 SYSTEM；不要 import 这些模块）。
3. 工具：删除 `submit_decision`；新增 `write_entry`、`attach_source`、`add_relation`、`finish_unit`（字段、校验、错误码见 spec）。写入使用 `appendSections` / `attachSectionSources`；`kb_entry_sources` 同步 upsert（evidence `[{ section_id, heading, quote: heading }]`）；`finish_unit` 用 `writeResults` 写 organize_results 与条目状态（organized → decision `new`/`supplement` 依据本单元是否新建词条；rejected → `reject`；not_learning；skipped 不改状态）；trace 记录 `agent_submit`。新词条重名返回 `name_exists` + entry_id。
4. `get_entry` 返回 `sections: [{ section_id, heading, source_item_ids }]` 与去标记的正文。
5. 测试：更新 agent-routes / mcp-route 测试；覆盖 write_entry 新建 + 补充、attach_source、name_exists、finish_unit 各状态、skill 文件一致性。

### Task C：词条页（边注）+ 备注锚点 + 详情 API

**拥有文件：** `domains/kb/detail.ts`、`domains/notes/**`、`http/routes/notes*.ts`（或 notes 路由所在文件）、`http/routes/kb*.ts`（如需）、`apps/workbench/src/pages/kb/KbEntryPage.tsx`、`KbEntryBody.tsx`、新建边注组件（如 `KbMargin.tsx`）、`apps/workbench/src/components/notes/**`、`components/organize/PendingOrganizeBar.tsx`、`styles/kb.css`、`apps/workbench/src/api/mock/kb.ts` 与 notes mock、`apps/workbench/src/api/real/*` 中 notes / kb、`pages/runs/RunTrace.tsx`（步骤标签：`knowledge_extract: "知识抽取 · LLM"`、`knowledge_align: "对齐词条 · LLM"`，删除 triage / compose 标签与分支，NODE_HINT 改为「抽取原文片段 → 对齐词条」）及 `RunTrace.test.tsx`、相关前端 / 后端测试（`test/kb/**`、`KbEntryPage.test.tsx`）。

**要求（见 spec「词条页」「整理依据」）：**
1. 详情 API：`sections` 按正文顺序列出有标记的章节；`notes` 带 `anchor`；`sources` 保留（边注卡片数据来源）。
2. notes：创建支持 `anchor`（仅 `scope='entry'`）；列表 / 详情返回 anchor。
3. 词条页布局：顶部压缩的关联图谱 + 掌握程度（一行两卡）；主体左正文、右边注栏；正文下方整篇备注（anchor 为空）+ 同分类词条。去掉旧侧栏与「来源与摘录」卡片。
4. 正文按 `parseSections` 分节渲染（标记行不显示）；每个有 id 的章节在右侧显示：来源卡片（图标、标题、类型、时间、问答问题跳转到对应轮、「对比原文」沿用 `KbCompareDialog`）+ 该章节备注列表 + 添加备注。卡片顶端与章节标题对齐，重叠顺延（测量 offsetTop + ResizeObserver）；< 1100px 边注折叠到每节末尾。无标记章节无边注；不属于任何章节的来源列在边注栏底部「其他来源」。
5. 词条页不显示条目备注、模糊备注、整理要求；`PendingOrganizeBar` 在词条页只依据 `dirty`（不再统计未用备注）。编辑器提示补充「请勿删除 `<!-- section … -->` 行」。
6. 测试：详情 sections 解析；锚定备注创建；词条页边注渲染（来源卡片出现在对应章节、章节备注）；RunTrace 新标签。
