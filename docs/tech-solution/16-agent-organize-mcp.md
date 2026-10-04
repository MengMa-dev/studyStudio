# 16 方案与实施计划（外部 Agent 整理：MCP + Skill）

目标：让用户在 Cursor / Claude Code / Codex 等 agent 中，通过本地服务暴露的 MCP 工具 + 一份薄 skill，自行完成收件箱整理。agent 负责阅读、抽取知识点、决定新建 / 补充 / 重复 / 拒绝并写作；**所有写入仍走 15 的校验与 ⑥ 入库链路**，产物与流水线同构（`organize_results`、整理记录、回收站撤销、索引全部复用）。

## 范围

| 内容 | 本期 |
| --- | --- |
| `local-ingestion` 挂 `/mcp`（Streamable HTTP，无状态），Bearer token 鉴权 | 做 |
| 读工具：规则、收件箱、单元内容（分块）、知识库检索、词条详情、词表 | 做 |
| 会话：`start_session` / `finish_session`，对应一条 `trigger = "agent"` 的 organize run | 做 |
| 写工具 `submit_decision`：compose / duplicate / reject / not_learning，服务端校验后入库 | 做 |
| 规则由服务端从 `PROMPTS` 实时下发（`get_guidelines`），skill 只写流程 | 做 |
| 设置页「Agent 接入」：token、三家客户端配置片段、安装 skill | 做 |
| 与自动整理 worker 互斥 | 做 |
| `preview_decision`（试写回滚） | 不做：`submit_decision` 校验失败本就不落库，写错可回收站撤销；有「先看再写」需求再加 |
| `rewrite_entry`（agent 重写词条） | 不做：supplement 后词条标 stale，下次 worker 运行自动 ⑦ 重写 |
| 删除词条、改类型词表、改分类结构 | 不做：留给 workbench |
| stdio 传输 | 不做：stdio 需另起进程开 SQLite，绕开服务内的索引 / 向量队列；三家客户端都支持 HTTP |
| agent 联网补充 / 知识库 lint | 不做（后续，见文末） |

## 选型结论

| # | 事项 | 结论 |
| --- | --- | --- |
| S25 | MCP 服务端 | `@modelcontextprotocol/sdk`（Web 标准 Streamable HTTP transport，无状态模式），挂在现有 Hono app；SDK 版本不含 Web 标准 transport 时改用 `@hono/mcp` |
| S26 | 会话状态 | 不用 MCP session；业务会话 = organize run，`runId` 由工具参数显式传递 |
| S27 | 规则来源 | 唯一来源 `ai/prompts/*`；`get_guidelines` 实时拼装，skill 不含规则正文 |
| S28 | 鉴权 | 独立 `mcp-token`（数据目录文件，0600），与扩展的 pairing token 分开，可单独重置 |

## 现有可复用能力

| 能力 | 位置 |
| --- | --- |
| 单元构建 | `domains/organize/pipeline.ts` `buildUnits` |
| 条目加载 | `domains/organize/store.ts` `loadItems` / `listAliveEntries` / `categoryNames` / `kbIgnoreNames` |
| 分块 | `domains/organize/chunk.ts` `chunkUnit` |
| 候选检索 | `domains/organize/retrieve.ts` `retrieveCandidates` |
| 知识点编号 | `domains/organize/process.ts` `collectPoints` |
| compose 校验 / 覆盖 / 组装 | `domains/organize/coverage.ts` `validateCompose` / `missingPoints` / `missingFeedback` / `assembleResult` |
| 入库 | `domains/organize/integrate.ts` `integrateExtraction` / `recordDuplicate` / `recordRejection` |
| 类型归一 | `domains/organize/kinds.ts` `resolveKind` / `kindVocabulary` |
| 词条详情 | `domains/kb` `getKbEntryDetail` |
| run 记录 | `domains/organize/run-store.ts` `createRun` / `updateRun` / `setJob` / `activeRuns` |
| token 文件写法 | `create-server.ts` `ensurePairingToken` |
| Prompt 注册表 | `ai/prompts/index.ts` `PROMPTS` |

---

## 总体架构

```text
Cursor / Claude Code / Codex
  │  skill: organize-kb（流程 + 「先调 get_guidelines」）
  │  MCP (HTTP, Authorization: Bearer <mcp-token>)
  ▼
local-ingestion  POST /mcp
  ├─ 读：get_guidelines / list_inbox / get_unit / search_kb / get_entry / list_vocab
  ├─ 会话：start_session / finish_session ──► organize_runs(trigger=agent)
  └─ 写：submit_decision
        ├─ compose：collectPoints → 引文校验 → validateCompose → missingPoints → assembleResult
        │           → integrateExtraction → 索引 / items.organize_status / setJob / run stats
        ├─ duplicate：recordDuplicate
        ├─ reject：recordRejection
        └─ not_learning：recordRejection(decision=not_learning)
```

agent 侧的工作 = 流水线 15 的 S1 判定 + S2 抽取 + S3/S4 写作；S5 校验由服务端执行并把错误返回给 agent 自行修正（替代流水线的有限回路）。

## MCP 工具

所有工具输入用 zod 定义，同时作为 MCP `inputSchema`。返回统一 `{ ok: true, ... } | { ok: false, error, details? }`，错误文本为中文、可直接给 agent 读。

### 读

| 工具 | 输入 | 输出 | 实现 |
| --- | --- | --- | --- |
| `get_guidelines` | `{ stage?: "triage" \| "extract" \| "compose" \| "all" }` | `{ version, markdown }` | `guidelines.ts`，见「规则下发」 |
| `list_inbox` | `{ limit?: number(≤50, 默认 20), cursor?: string }` | `{ units: [{ unit_key, item_ids, type, title, url, captured_at, has_note, has_highlight, tokens }], next_cursor }` | 取 `organize_status IN ('pending','failed')` 的条目 → `loadItems` → `buildUnits(items, null, { path: "agent", adoptOf: () => false })` |
| `get_unit` | `{ unit_key }` | `{ unit_key, item_ids, title, url, user_highlights, user_note, chunks: ContentChunk[] }` | 重新 `buildUnits` 定位单元 → `chunkUnit` |
| `search_kb` | `{ query: string, limit?: number(≤20, 默认 8) }` | `{ entries: [{ entry_id, name, aliases, kind, category, summary, score }] }` | `retrieveCandidates`（以 query 构造临时单元查询；无向量索引时退化为 FTS） |
| `get_entry` | `{ entry_id }` | `{ entry_id, name, aliases, kind, category, body, outline, user_edited, relations }` | `getKbEntryDetail` |
| `list_vocab` | `{}` | `{ kinds: string[], categories: string[], ignored_names: string[] }` | `kindVocabulary` / `categoryNames` / `kbIgnoreNames` |

### 会话

| 工具 | 输入 | 输出 | 行为 |
| --- | --- | --- | --- |
| `start_session` | `{ client?: string }` | `{ run_id, skill_version }` | 有活动 run（worker 或其他 agent 会话）→ `ok: false, error: "busy"`；否则 `createRun({ trigger: "agent", scope: null, ... })` 并置 `running` |
| `finish_session` | `{ run_id, summary?: string }` | `{ stats }` | run 置 `finished`，汇总 stats；返回本次词条变化 |

空闲超时：会话 30 分钟无写入，worker 心跳时将其置 `finished`（`stats` 照常保留），释放互斥。

### 写：`submit_decision`

```ts
const pointInput = z.object({
  statement: z.string().min(1),
  quote: z.string().min(1),
  section: z.string().nullable(),
  concept: z.string().min(1),
  importance: z.enum(POINT_IMPORTANCE),
  turn_item_id: z.string().nullable()
});

export const submitDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    run_id: z.string(), unit_key: z.string(), decision: z.literal("compose"),
    value_score: z.number().min(0).max(1), reason: z.string(),
    thesis: z.string(),
    /** Ordered; compose refers to them as p1…pn by position. */
    points: z.array(pointInput).min(1),
    compose: knowledgeComposeOutputSchema
  }),
  z.object({
    run_id: z.string(), unit_key: z.string(), decision: z.literal("duplicate"), reason: z.string(),
    target_entry_ids: z.array(z.string()).min(1),
    evidence: z.array(z.object({ entry_id: z.string(), quote: z.string() })).default([])
  }),
  z.object({
    run_id: z.string(), unit_key: z.string(), decision: z.literal("reject"), reason: z.string(),
    reject_reason: rejectReasonSchema
  }),
  z.object({ run_id: z.string(), unit_key: z.string(), decision: z.literal("not_learning"), reason: z.string() })
]);
```

服务端处理顺序（compose）：

1. `run_id` 必须是本人活动 agent run；`unit_key` 对应条目仍为 pending / failed（否则 `already_organized`）。
2. `collectPoints(unit, [{ points }])` 编号 p1…pn。
3. **引文校验**：每个 `quote` 归一化空白后必须是单元正文子串；不通过 → `ok: false, error: "quote_not_found", details: [pointIndex…]`（防编造证据，信任边界）。
4. `validateCompose(compose, points, knownEntryIds)` 有错 → 返回错误列表，不落库。
5. `missingPoints` 非空 → 返回 `missingFeedback(points)`，不落库。
6. `assembleResult` → `integrateExtraction`（`ResultRecord.model = "agent:<client>"`、`promptVersion = guidelines version`、`route = "agent"`）。
7. 提交后处理（与流水线共用 `commit.ts`）：词条索引、`items.organize_status`、`setJob`、run stats、SSE 事件。

返回 `{ ok: true, entry_changes: [{ entry_id, name, change }], edges_created }`。

其他决定：

- duplicate：单元有用户划线 / 笔记 → `marked_requires_compose`（同流水线 S1 规则：标记过的内容不在判定阶段判重复，须走 compose，全部已覆盖时在 `dropped` 中以 `covered` 标注）；`target_entry_ids` 必须是存活词条（否则 `unknown_entry`）；`evidence.quote` 同样做引文校验 → `recordDuplicate`。
- reject → `recordRejection(decision=reject, reject_reason)`；not_learning → `recordRejection(decision=not_learning)`。

单元定位：`domains/agent/units.ts`（`unitKey` = 首条目 id、`pendingUnits`、`findUnit`），`list_inbox` / `get_unit` / `submit_decision` 共用。

## 规则下发（`get_guidelines`）

```text
# 整理规则（version: organize-agent@1 / <PROCESSING_PROMPT_VERSION>）
## 判定（来自 knowledge_triage SYSTEM）
## 抽取知识点（来自 knowledge_extract SYSTEM）
## 组织写作（来自 knowledge_compose SYSTEM）
## Agent 补充约束（guidelines.ts 内常量，见下）
```

- 正文直接引用 `PROMPTS.*.system`，去掉其中「只输出 JSON」类单次调用指令（三个 prompt 文件各导出 `RULES`（规则正文）与 `SYSTEM = RULES + 输出约定`，`guidelines.ts` 只拼 `RULES`）。
- Agent 补充约束（短）：引文必须原文摘录；一个单元一次 `submit_decision`；校验失败按返回信息修正后重交，同一单元最多 3 次，仍失败则 `reject(low_information)` 并在 `finish_session.summary` 说明。
- `version` 写入 `organize_results.prompt_version`，便于与流水线产物对比。

改 prompt → 重启服务 → 所有 agent 下次会话自动生效，skill 无需更新。

## Skill（`organize-kb`）

单一来源：`services/local-ingestion/src/domains/agent/skill/SKILL.md`，只写稳定流程：

```markdown
---
name: organize-kb
description: 整理 Study Studio 收件箱到知识库。用户说「整理收件箱 / 整理学习记录 / organize inbox」时使用。需要 study-studio MCP。
skillVersion: 1
---

1. 调用 get_guidelines(stage="all")，后续判断与写作严格按其规则。
2. start_session；若 busy，告诉用户自动整理正在运行，稍后再试，结束。
3. list_inbox 取一批单元；逐个：
   a. get_unit 读全文分块；
   b. 判定：非学习内容 → not_learning；低价值 / 导航 / 临时 → reject；
   c. 抽取知识点（按规则，引文原样摘录，按顺序编号 p1…pn）；
   d. 每个概念 search_kb，必要时 get_entry 对比，决定补充已有词条或新建；
      全部已覆盖 → duplicate；
   e. list_vocab 选 kind / 分类（优先复用）；
   f. submit_decision；失败按返回信息修正重交（≤3 次）。
4. 处理完或用户要求停止 → finish_session，向用户汇报新建 / 补充 / 拒绝数量与词条名。

禁止：编造引文；跨单元合并提交；用其他方式修改知识库文件或数据库。
```

`start_session` 返回服务端期望的 `skill_version`；不一致时工具结果附带提示「skill 已更新，请在设置页重新安装」，不阻断。

## 接入与分发

设置页新增「Agent 接入」区块：

| 项 | 内容 |
| --- | --- |
| MCP 地址 / token | `http://127.0.0.1:<port>/mcp`、`mcp-token`（复制 / 重置） |
| Cursor | `~/.cursor/mcp.json` 片段：`{ "mcpServers": { "study-studio": { "url": "...", "headers": { "Authorization": "Bearer <token>" } } } }` |
| Claude Code | `claude mcp add --transport http study-studio <url> --header "Authorization: Bearer <token>"` |
| Codex | `~/.codex/config.toml` 片段：`[mcp_servers.study-studio]`，`url` + `bearer_token_env_var` |
| 安装 skill | 勾选目标（`~/.cursor/skills`、`~/.claude/skills`、`~/.codex/skills`）→ `POST /v1/agent/skill/install` 写入 `organize-kb/SKILL.md` |

客户端配置格式以各家当前文档为准，片段放在前端常量，随客户端变化单独改。

## 并发与一致性

- 互斥：worker 取下一个 queued run 前检查是否存在 `running` 的 agent run，有则等待；`start_session` 在有任何活动 run 时返回 busy。
  ponytail: 全局互斥；需要 agent 与自动整理并行时改为按单元加锁（`items.organize_status = 'claimed'`）。
- 服务重启：`requeueInterruptedRuns` 跳过 `trigger = "agent"`，改为置 `finished`（agent 会话不可续跑）。
- 单元幂等：提交前检查条目状态，重复提交返回 `already_organized`。

## 安全

- `/mcp` 走现有 `hostGuard`（仅 localhost）+ `requireMcpToken`；不接受 workbench cookie，避免浏览器跨站调用。
- 工具不暴露文件路径、SQL、删除能力；写入只有 `submit_decision`。
- 引文子串校验 + `validateCompose` 是信任边界，不可省。

## 测试

| 文件 | 用例 |
| --- | --- |
| `test/agent/session.test.ts` | 无活动 run → 创建 agent run；有活动 run → busy；超时置 finished；重启时 agent run 置 finished 而非 requeue |
| `test/agent/submit.test.ts` | compose 合法 → 词条新建 / 补充、items 状态更新、`organize_results.route = "agent"`；引文不在正文 → `quote_not_found` 且无写入；`validateCompose` 失败 → 错误返回无写入；遗漏 core 点 → missing feedback；重复提交 → `already_organized`；duplicate / reject / not_learning 各一 |
| `test/agent/guidelines.test.ts` | 输出包含三段 `RULES`、不含「只输出 JSON」、version 含 `PROCESSING_PROMPT_VERSION` |
| `test/agent/mcp-route.test.ts` | 无 token → 401；`tools/list` 含 9 个工具；`tools/call list_inbox` 返回单元 |
| `test/organize/pipeline.test.ts` | 抽出 `commit.ts` 后原用例全部通过 |

---

# 实施计划

前置：当前工作区有未提交的 extension / kb / organize 改动，先提交或单独分支再开始。

单测命令：`node --import tsx --test services/local-ingestion/test/<dir>/<file>.test.ts`

## Task 1：抽出提交逻辑（重构，行为不变）

**Files**
- Create：`services/local-ingestion/src/domains/organize/commit.ts`
- Modify：`services/local-ingestion/src/domains/organize/pipeline.ts`（`afterIntegration` / `finishItems` 改为调用 commit）

**Produces**

```ts
export type CommitDeps = { db: DatabaseSync; indexCtx: IndexContext; runId: string; now: string };
/** Index touched entries, update items.organize_status, set jobs. Returns entry ids queued for body indexing. */
export async function commitUnit(
  deps: CommitDeps,
  items: OrganizeItem[],
  result: IntegrationResult | null,
  status: JobStatus,
  decision: OrganizeDecision | null
): Promise<string[]>;
```

- [ ] 把 `afterIntegration` 中与 `RunState` 无关的部分（索引摘要、指纹、状态更新、`setJob`）移入 `commitUnit`；stats / progress 仍留在 pipeline
- [ ] `node --import tsx --test services/local-ingestion/test/organize/pipeline.test.ts` 全部通过
- [ ] Commit：`refactor(organize): extract commitUnit for shared integration tail`

## Task 2：Agent 会话与互斥

**Files**
- Modify：`packages/shared/src/api/organize.ts`（`organizeTriggerSchema` 加 `"agent"`）
- Create：`services/local-ingestion/src/domains/agent/session.ts`
- Modify：`services/local-ingestion/src/domains/organize/run-store.ts`（`requeueInterruptedRuns` 排除 agent）
- Modify：`services/local-ingestion/src/jobs/organize-worker.ts`（取 run 前检查 agent run；心跳内调用 `expireIdleAgentRuns`）
- Test：`services/local-ingestion/test/agent/session.test.ts`

**Produces**

```ts
export const AGENT_IDLE_MS = 30 * 60 * 1000;
export function startAgentSession(db: DatabaseSync, client: string | null): { ok: true; runId: string } | { ok: false; error: "busy"; activeRunId: string };
export function requireAgentRun(db: DatabaseSync, runId: string): OrganizeRunRow; // throws AgentToolError("run_not_active")
export function touchAgentRun(db: DatabaseSync, runId: string, now: string): void;
export function finishAgentSession(db: DatabaseSync, runId: string, summary: string | null): OrganizeRunStats;
export function expireIdleAgentRuns(db: DatabaseSync, now: Date): number;
```

- [ ] 写失败测试（「测试」表 session 四个用例）
- [ ] 实现；workbench 整理记录页 trigger 文案加「Agent」（`apps/workbench` 中 trigger 文案映射处）
- [ ] 测试通过；`npm run typecheck`
- [ ] Commit：`feat(agent): organize sessions as agent-triggered runs`

## Task 3：规则下发

**Files**
- Modify：`services/local-ingestion/src/ai/prompts/knowledge-triage.ts`、`knowledge-extract.ts`、`knowledge-compose.ts`（拆出 `RULES`，`SYSTEM = RULES + 输出约定`，`PROMPT_VERSION` 不变：拼接结果与原 SYSTEM 字节一致）
- Create：`services/local-ingestion/src/domains/agent/guidelines.ts`
- Test：`services/local-ingestion/test/agent/guidelines.test.ts`

**Produces**

```ts
export const AGENT_GUIDELINES_VERSION = `organize-agent@1(${PROCESSING_PROMPT_VERSION})`;
export function buildGuidelines(stage: "triage" | "extract" | "compose" | "all"): { version: string; markdown: string };
```

- [ ] 测试：`SYSTEM === RULES + OUTPUT` 对三个 prompt 成立（保证不改变流水线行为）；guidelines 用例
- [ ] 实现并通过
- [ ] Commit：`feat(agent): serve organize guidelines from prompt rules`

## Task 4：MCP 路由与读工具

**Files**
- Modify：`services/local-ingestion/package.json`（加 `@modelcontextprotocol/sdk`）
- Modify：`services/local-ingestion/src/create-server.ts`（`ensureMcpToken`，同 `ensurePairingToken` 写法，文件 `mcp-token`）
- Modify：`services/local-ingestion/src/http/auth.ts`（`requireMcpToken`）
- Create：`services/local-ingestion/src/domains/agent/tools.ts`（工具定义：name、description、zod input、handler）
- Create：`services/local-ingestion/src/http/routes/mcp.ts`（`POST /mcp`：每请求新建 server + 无状态 transport，注册 `tools.ts`）
- Modify：`services/local-ingestion/src/http/app.ts`（注册路由）
- Test：`services/local-ingestion/test/agent/mcp-route.test.ts`

**Produces**

```ts
export type AgentToolDeps = { db: DatabaseSync; indexCtx: IndexContext; now: () => Date };
export type AgentTool<I> = { name: string; description: string; input: z.ZodType<I>; handler: (deps: AgentToolDeps, input: I) => Promise<unknown> };
export function agentTools(): AgentTool<any>[];
export class AgentToolError extends Error { constructor(readonly code: string, message: string, readonly details?: unknown) }
```

- [ ] 确认 SDK 版本的 Web 标准 transport 导出路径；不可用则改用 `@hono/mcp`（S25）
- [ ] 写失败测试：无 token 401；`tools/list`；`list_inbox` / `get_unit` / `search_kb` / `get_entry` / `list_vocab` / `get_guidelines` / `start_session` / `finish_session` 调用成功
- [ ] 实现读工具与会话工具（handler 内 `AgentToolError` → `{ ok: false, error: code, details }`）
- [ ] 测试通过；`npm run typecheck`
- [ ] Commit：`feat(agent): MCP endpoint with read and session tools`

## Task 5：`submit_decision`

**Files**
- Create：`services/local-ingestion/src/domains/agent/submit.ts`
- Modify：`services/local-ingestion/src/domains/agent/tools.ts`（注册）
- Test：`services/local-ingestion/test/agent/submit.test.ts`

**Consumes**：`collectPoints`、`validateCompose`、`missingPoints`、`missingFeedback`、`assembleResult`、`integrateExtraction`、`recordDuplicate`、`recordRejection`、`commitUnit`、`requireAgentRun`、`touchAgentRun`

**Produces**：`submitDecisionSchema`、`submitDecision(deps: AgentToolDeps, input: SubmitDecisionInput, client: string | null): Promise<SubmitResult>`

- [ ] 写失败测试（「测试」表 submit 用例；fixture 复用 `test/fixtures/llm/samples.ts` 中 compose 样例构造 `points` + `compose`）
- [ ] 实现（按「写：submit_decision」处理顺序）
- [ ] 测试通过；`node --import tsx --test services/local-ingestion/test/organize/*.test.ts` 无回归
- [ ] Commit：`feat(agent): submit_decision through compose validation and integration`

## Task 6：Skill 与设置页接入

**Files**
- Create：`services/local-ingestion/src/domains/agent/skill/SKILL.md`（上文内容）
- Create：`services/local-ingestion/src/http/routes/agent.ts`（`GET /v1/agent/config` → `{ url, token, skillVersion }`；`POST /v1/agent/token/reset`；`POST /v1/agent/skill/install { targets: ("cursor"|"claude"|"codex")[] }`，写 `~/<dir>/skills/organize-kb/SKILL.md`）
- Modify：`packages/shared/src/api/`（新增 agent DTO）
- Modify：`apps/workbench` 设置页（新增「Agent 接入」区块：地址 / token 复制与重置、三家配置片段、安装 skill）
- Test：`services/local-ingestion/test/agent/agent-routes.test.ts`（install 写入临时 HOME；token reset 后旧 token 401）

- [ ] 写失败测试 → 实现 → 通过
- [ ] Commit：`feat(agent): skill install and agent settings`

## Task 7：真实 agent 联调与文档

- [ ] 用 Claude Code 接入本地服务，跑「整理收件箱」：至少覆盖 new / supplement / reject 各 1 个单元；整理记录页可见 Agent run；回收站可撤销
- [ ] Cursor、Codex 各跑 1 次，记录配置片段是否需要修正
- [ ] 更新 `docs/tech-solution/00-overview.md`（能力列表）、`07-organize.md`（新增 agent 路径一节，链接本文）
- [ ] 联调结束停止本地服务与 agent 进程
- [ ] Commit：`docs(agent): agent organize via MCP`

# 验收

- agent 整理的单元在整理记录、`organize_results`、知识库中与流水线产物同构；可回收站撤销。
- 编造引文 / 遗漏核心知识点 / 非法词条 id 均被拒绝且无写入，agent 能根据返回修正。
- 修改 `ai/prompts/*` 规则后重启服务，`get_guidelines` 立即反映，skill 无需改动。
- agent 会话期间自动整理不并发运行；会话异常中断 30 分钟后自动释放。

# 后续

- `preview_decision`、`rewrite_entry`（按需）。
- agent 执行知识库 lint（矛盾、孤立词条、缺失关系）：新增只读 `list_entries` / `get_kb_graph` + 写工具 `add_relation`。
- 按单元加锁，允许 agent 与自动整理并行。
