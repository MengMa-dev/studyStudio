import assert from "node:assert/strict";
import { test } from "node:test";
import { appendSections, parseSections } from "@study-studio/shared";
import { runJobs } from "../../src/domains/organize/run-store";
import { runTrace } from "../../src/domains/organize/trace";
import { checkExtract } from "../../src/domains/organize/verify";
import {
  alignment,
  createEnv,
  createReplayGateway,
  entry,
  insertEntry,
  insertItem,
  insertNote,
  insertSelection,
  insertSource,
  itemStatus,
  newEntry,
  output,
  recordedContent,
  recordedTurns,
  replay,
  result,
  runPipeline,
  sectionFragments,
  setLearnerProfile,
  stepCalls,
  steps,
  type TestEnv
} from "./helpers";

const T = (minutes: number) => new Date(Date.parse("2026-10-02T12:00:00.000Z") + minutes * 60_000).toISOString();

const HITL_BODY =
  "## 定义\n在 Agent 执行过程中插入人工审批或输入节点，由人确认后再继续。\n## 实现方式\nLangGraph 中用 interrupt() 暂停。\n## 用途\n- 工具调用前审批";
const CHECKPOINT_BODY = "## 定义\nLangGraph 在每个 super-step 结束时把图状态保存为 checkpoint。\n## 用途\n- 对话记忆\n- 失败恢复";

function seedLangGraphKb(env: TestEnv, options: { hitlUserEdited?: boolean } = {}): void {
  insertEntry(env.db, {
    id: "kb_hitl",
    name: "Human-in-the-loop",
    aliases: ["HITL", "人在回路"],
    body: HITL_BODY,
    summary: "人工审批节点",
    category: "Agent 框架",
    userEdited: options.hitlUserEdited
  });
  insertEntry(env.db, { id: "kb_checkpoint", name: "Checkpoint", aliases: ["检查点", "checkpointer"], body: CHECKPOINT_BODY, category: "Agent 框架" });
}

function seedLangGraphItems(env: TestEnv): void {
  const [first, second] = recordedTurns("conversation-thread");
  insertItem(env.db, {
    id: "item_B",
    type: "conversation",
    title: "ChatGPT：checkpoint 和 interrupt 有什么区别？",
    capturedAt: T(0),
    question: first!.question,
    markdown: first!.answer,
    conversationId: "conv_lg"
  });
  insertItem(env.db, {
    id: "item_B2",
    type: "conversation",
    title: "ChatGPT：interrupt 恢复时状态从哪里读？",
    capturedAt: T(3),
    question: second!.question,
    markdown: second!.answer,
    conversationId: "conv_lg"
  });
  insertItem(env.db, {
    id: "item_C",
    title: "Human-in-the-loop - LangGraph Docs",
    url: "https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/",
    capturedAt: T(10),
    markdown: recordedContent("supplement")
  });
}

/** Thread item_B (+ item_B2): turn 1 → Checkpoint, turn 2 → HITL; item_C: every section → HITL. */
function langGraphSteps() {
  const [first, second] = recordedTurns("conversation-thread");
  const thread = [...sectionFragments(first!.answer, "Checkpoint", "item_B"), ...sectionFragments(second!.answer, "Human-in-the-loop", "item_B2")];
  const relations = [{ from: "Checkpoint", to: "Human-in-the-loop", type: "contrasts" as const, description: "checkpoint 是持久化，interrupt 是控制流" }];
  const docs = sectionFragments(recordedContent("supplement"), "Human-in-the-loop");
  return [
    ...steps("item_B", thread, alignment(["kb_checkpoint", "kb_hitl"], { relations })),
    ...steps(
      "item_C",
      docs,
      alignment(docs.map(() => "kb_hitl"))
    )
  ];
}

function learningJudge(candidates: string[], engagement: Record<string, "weak" | "medium" | "strong">, patch: Record<string, unknown> = {}) {
  return output("learning_judge", "learning", {
    candidate_item_ids: candidates,
    item_engagement: Object.entries(engagement).map(([item_id, level]) => ({ item_id, engagement: level })),
    ...patch
  });
}

const judgeAll = () => replay.judge(learningJudge(["item_B", "item_B2", "item_C"], { item_B: "strong", item_B2: "strong", item_C: "strong" }));

function kpCalls(prompts: Array<{ input: unknown }>, itemId?: string) {
  return prompts.filter((call) => {
    const input = call.input as { item?: { item_id?: string }; timeline?: unknown };
    return input?.item?.item_id && (!itemId || input.item.item_id === itemId);
  });
}

function rawOutput(env: TestEnv, itemId: string) {
  return (JSON.parse(String(result(env.db, itemId)!.output)) as { raw: Record<string, unknown> }).raw;
}

test("③ learning episode → ⑤ extract + align → ⑥ appends marked sections and sources", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  setLearnerProfile(env.db);
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const { gateway, prompts } = createReplayGateway([judgeAll(), ...langGraphSteps()]);

  const { runId, result: run } = await runPipeline(env, gateway);

  assert.equal(run.status, "completed");
  assert.equal(run.stats.items.ingested, 3);
  assert.equal(run.stats.decisions.supplement, 2);
  assert.equal(run.stats.episodes.learning, 1);
  assert.equal(run.stats.kb.relationsCreated, 1);
  assert.equal(run.model, "replay");
  for (const id of ["item_B", "item_B2", "item_C"]) assert.equal(itemStatus(env.db, id).organize_status, "ingested");

  assert.equal(kpCalls(prompts, "item_B2").length, 0, "follow-up turn is processed with its thread");
  const [extract] = stepCalls(prompts, "extract", "item_B") as Array<{ turns: Array<{ turn_item_id: string; answer: string }>; text: string | null }>;
  assert.deepEqual(
    extract!.turns.map((turn) => turn.turn_item_id),
    ["item_B", "item_B2"]
  );
  assert.equal(extract!.text, null);
  assert.equal(extract!.turns[0]!.answer, recordedTurns("conversation-thread")[0]!.answer, "the whole answer is sent, not a chunk");
  assert.ok(!("episode" in extract!) && !("learner_profile" in extract!), "judge topic / profile are not passed to extract");
  const [align] = stepCalls(prompts, "align", "item_B") as Array<{ candidate_entries: Array<{ entry_id: string; sections: Array<{ section_id: string }> }> }>;
  assert.ok(align!.candidate_entries.some((candidate) => candidate.entry_id === "kb_checkpoint"));
  assert.deepEqual(
    align!.candidate_entries.find((candidate) => candidate.entry_id === "kb_checkpoint")!.sections.map((section) => section.section_id),
    ["u_0", "u_1"],
    "unmarked sections get temporary ids"
  );

  const hitl = entry(env.db, "kb_hitl")!;
  const sections = parseSections(String(hitl.body_markdown));
  assert.deepEqual(sections.slice(0, 3), parseSections(HITL_BODY), "existing sections are kept, new ones are appended");
  assert.deepEqual(
    sections.filter((section) => section.id).map((section) => [section.heading, section.sourceItemIds]),
    [
      ["Human-in-the-loop", ["item_B2"]],
      ["Overview", ["item_C"]],
      ["interrupt", ["item_C"]],
      ["Requirements", ["item_C"]],
      ["Design patterns", ["item_C"]],
      ["Caveats", ["item_C"]]
    ]
  );
  assert.ok(sections.some((section) => section.markdown.includes("Command(resume=value)")), "fragment text is written verbatim");
  assert.equal(Number(hitl.patch_count), 2);
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_hitl' AND item_id = 'item_C'").get() as { evidence: string };
  const evidence = JSON.parse(source.evidence) as Array<{ section_id: string; heading: string; quote: string }>;
  assert.equal(evidence.length, 5);
  assert.ok(evidence.every((row) => row.section_id.startsWith("s_") && row.quote === row.heading));
  const qa = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_checkpoint' AND item_id = 'item_B'").get() as { evidence: string };
  const qaEvidence = JSON.parse(qa.evidence) as Array<{ question?: string; turnItemId?: string }>;
  assert.ok(qaEvidence.length > 0);
  assert.ok(qaEvidence.every((row) => row.question === recordedTurns("conversation-thread")[0]!.question && row.turnItemId === "item_B"));

  const stored = result(env.db, "item_C")!;
  assert.equal(stored.decision, "supplement");
  assert.equal(stored.run_id, runId);
  assert.equal(stored.prompt_version, "organize@4(knowledge_extract@4+knowledge_align@3)");
  assert.ok(String(stored.target_entry_ids).includes("kb_hitl"));
  assert.ok(runJobs(env.db, runId).every((job) => job.status === "ingested"));

  const trace = runTrace(env.db, runId);
  const stepNames = new Set(trace.map((step) => step.step));
  for (const name of ["context", "episodes", "learning_judge", "judge_verdict", "retrieve", "knowledge_extract", "knowledge_align", "processing_result", "integration"]) {
    assert.ok(stepNames.has(name), `trace has ${name}`);
  }
  assert.deepEqual(
    trace.map((step) => step.seq),
    trace.map((_, index) => index + 1)
  );
});

test("③ non-learning episode rejects items; a noted item is forced into ⑤ and no fragments → reject", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertItem(env.db, { id: "item_news", title: "今日热点新闻", capturedAt: T(0), markdown: recordedContent("reject-low-information") });
  insertItem(env.db, {
    id: "item_vite_port",
    title: "Vite dev server: Error: listen EADDRINUSE",
    url: "https://stackoverflow.com/questions/vite-eaddrinuse",
    capturedAt: T(5),
    markdown: recordedContent("reject-transient")
  });
  insertNote(env.db, { id: "note_vite", scope: "item", targetId: "item_vite_port", text: "以后端口冲突就这么处理", createdAt: T(6) });
  const removed = [
    { source_section: "## Question", reason: "boilerplate" as const },
    { source_section: "## Accepted answer", reason: "boilerplate" as const }
  ];
  const { gateway, prompts } = createReplayGateway([
    replay.judge(output("learning_judge", "non-learning")),
    replay.extract("item_vite_port", { fragments: [], removed })
  ]);

  const { result: run } = await runPipeline(env, gateway);

  assert.equal(result(env.db, "item_news")!.decision, "not_learning");
  assert.equal(kpCalls(prompts, "item_news").length, 0);
  const extracts = stepCalls(prompts, "extract", "item_vite_port") as Array<{ instructions: Array<{ kind: string; text: string }> }>;
  assert.equal(extracts.length, 1);
  assert.deepEqual(extracts[0]!.instructions, [{ kind: "item_note", text: "以后端口冲突就这么处理" }]);
  assert.equal(stepCalls(prompts, "align").length, 0, "no fragments stops before align");
  const stored = result(env.db, "item_vite_port")!;
  assert.equal(stored.decision, "reject");
  assert.equal(stored.reject_reason, "low_information");
  assert.equal(run.stats.decisions.notLearning, 1);
  assert.equal(run.stats.decisions.reject, 1);
  const note = env.db.prepare("SELECT used_at FROM notes WHERE id = 'note_vite'").get() as { used_at: string | null };
  assert.ok(note.used_at, "notes fed to ⑤ are marked used");
});

test("⑤ new: a new entry is built from fragment sections, relations resolve, vectors are indexed", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_function_calling", name: "Function Calling", aliases: ["工具调用"], body: "## 定义\n让模型输出结构化的函数调用。" });
  insertItem(env.db, {
    id: "item_mcp_intro",
    title: "Introduction - Model Context Protocol",
    url: "https://modelcontextprotocol.io/introduction",
    capturedAt: T(0),
    markdown: recordedContent("new")
  });
  const fragments = sectionFragments(recordedContent("new"), "Model Context Protocol");
  const { gateway } = createReplayGateway([
    replay.judge(learningJudge(["item_mcp_intro"], { item_mcp_intro: "medium" }, { related_exploration: ["Function Calling"] })),
    ...steps(
      "item_mcp_intro",
      fragments,
      alignment(
        fragments.map(() => "new:Model Context Protocol"),
        {
          new_entries: [newEntry("Model Context Protocol", { aliases: ["MCP"], kind: "规范" })],
          relations: [{ from: "Model Context Protocol", to: "Function Calling", type: "related", description: null }]
        }
      )
    )
  ]);

  const { result: run } = await runPipeline(env, gateway);

  assert.equal(run.stats.kb.entriesCreated, 1);
  assert.equal(run.stats.decisions.new, 1);
  const created = env.db.prepare("SELECT id, kind, aliases, body_markdown, patch_count FROM kb_entries WHERE name = 'Model Context Protocol'").get() as {
    id: string;
    kind: string;
    aliases: string;
    body_markdown: string;
    patch_count: number;
  };
  assert.equal(created.kind, "规范");
  assert.deepEqual(JSON.parse(created.aliases), ["MCP"]);
  assert.equal(created.patch_count, 0);
  assert.deepEqual(
    parseSections(created.body_markdown).map((section) => [section.heading, section.sourceItemIds]),
    ["What is MCP?", "Why MCP?", "General architecture", "Get started"].map((heading) => [heading, ["item_mcp_intro"]])
  );
  assert.ok(env.db.prepare("SELECT 1 FROM kb_edges WHERE src = ? AND dst = 'kb_function_calling' AND type = 'related'").get(created.id));
  const owners = env.db.prepare("SELECT DISTINCT owner_type FROM chunks WHERE owner_id = ?").all(created.id) as Array<{ owner_type: string }>;
  assert.deepEqual(owners.map((row) => row.owner_type).sort(), ["entry", "entry_name", "entry_summary"]);
});

test("⑤ duplicate: a second source covering existing sections only attaches the source", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const content = recordedContent("duplicate");
  const original = sectionFragments(content, "RAG 重排");
  const seeded = appendSections(
    "",
    original.map((fragment) => ({ heading: fragment.heading, markdown: fragment.markdown, sourceItemIds: ["item_first"] }))
  );
  insertEntry(env.db, { id: "kb_rerank", name: "RAG 重排", aliases: ["Rerank", "重排序"], kind: "method", body: seeded.body, patchCount: 1 });
  insertItem(env.db, { id: "item_first", title: "第一篇", capturedAt: T(-100), markdown: content, status: "ingested" });
  insertItem(env.db, {
    id: "item_rerank_blog",
    title: "RAG 优化：为什么要加一层 Rerank",
    url: "https://example-blog.dev/rag-rerank",
    capturedAt: T(0),
    markdown: content
  });
  insertSelection(env.db, "item_rerank_blog", "再用 cross-encoder 重排模型对「问题-片段」逐对打分", T(-1));
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_rerank_blog"], { item_rerank_blog: "weak" }, { related_exploration: ["Rerank"] })),
    ...steps(
      "item_rerank_blog",
      original,
      alignment(seeded.ids.map((id) => ["kb_rerank", id] as [string, string]))
    )
  ]);

  const { result: run } = await runPipeline(env, gateway);

  const [extract] = stepCalls(prompts, "extract", "item_rerank_blog") as Array<{ user_highlights: string[] }>;
  assert.deepEqual(extract!.user_highlights, ["再用 cross-encoder 重排模型对「问题-片段」逐对打分"]);
  const [align] = stepCalls(prompts, "align", "item_rerank_blog") as Array<{ candidate_entries: Array<{ entry_id: string; sections: Array<{ section_id: string }> }> }>;
  assert.deepEqual(
    align!.candidate_entries.find((candidate) => candidate.entry_id === "kb_rerank")!.sections.map((section) => section.section_id),
    seeded.ids
  );
  assert.equal(result(env.db, "item_rerank_blog")!.decision, "duplicate");
  assert.equal(run.stats.decisions.duplicate, 1);
  assert.equal(itemStatus(env.db, "item_rerank_blog").organize_status, "ingested");
  const stored = entry(env.db, "kb_rerank")!;
  assert.equal(stored.patch_count, 1, "no text appended");
  const sections = parseSections(String(stored.body_markdown));
  assert.deepEqual(
    sections.map((section) => section.markdown),
    original.map((fragment) => fragment.markdown)
  );
  assert.ok(sections.every((section) => section.sourceItemIds.join(",") === "item_first,item_rerank_blog"));
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_rerank' AND item_id = 'item_rerank_blog'").get() as {
    evidence: string;
  };
  assert.deepEqual(
    (JSON.parse(source.evidence) as Array<{ section_id: string }>).map((row) => row.section_id),
    seeded.ids
  );
});

test("adopt mode: rejected item selected manually skips judge, legacy pattern kind maps to 技巧", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_agent_loop", name: "Agent Loop", aliases: ["智能体循环"], kind: "method", body: "## 定义\n循环调用工具。" });
  insertItem(env.db, {
    id: "item_react_post",
    title: "一句话理解 ReAct",
    url: "https://v2ex.example/t/react-agent",
    capturedAt: T(0),
    markdown: recordedContent("adopt"),
    status: "rejected"
  });
  const fragments = sectionFragments(recordedContent("adopt"), "ReAct");
  const { gateway, prompts } = createReplayGateway([
    ...steps(
      "item_react_post",
      fragments,
      alignment(["new:ReAct"], {
        new_entries: [newEntry("ReAct", { kind: "pattern" })],
        relations: [{ from: "ReAct", to: "Agent Loop", type: "part_of", description: null }]
      })
    )
  ]);

  const { result: run } = await runPipeline(env, gateway, { scope: "inbox_selected", itemIds: ["item_react_post"] });

  assert.equal(prompts.filter((call) => Array.isArray((call.input as { timeline?: unknown }).timeline)).length, 0, "direct path skips ③");
  const stored = result(env.db, "item_react_post")!;
  assert.equal(stored.decision, "new");
  assert.equal(stored.override, "adopt");
  assert.equal(stored.route, "llm");
  const created = env.db.prepare("SELECT kind FROM kb_entries WHERE name = 'ReAct'").get() as { kind: string };
  assert.equal(created.kind, "技巧");
  assert.equal(run.stats.decisions.new, 1);
});

test("adopt mode: extract without fragments fails the unit instead of rejecting", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertItem(env.db, { id: "item_react_post", title: "一句话理解 ReAct", capturedAt: T(0), markdown: recordedContent("adopt"), status: "rejected" });
  const removed = [{ source_section: "## 正文", reason: "boilerplate" as const }];
  const { gateway } = createReplayGateway([replay.extract("item_react_post", { fragments: [], removed })]);

  const { result: run } = await runPipeline(env, gateway, { scope: "inbox_selected", itemIds: ["item_react_post"] });

  assert.equal(itemStatus(env.db, "item_react_post").organize_status, "failed");
  assert.equal(run.stats.items.failed, 1);
  assert.equal(result(env.db, "item_react_post"), undefined);
});

const LONG_ANSWER = [
  "好问题！下面分几部分说明。",
  "## 1. LLM Wiki 到底是什么？",
  "LLM Wiki 是由大模型持续维护的个人知识库：每次读到新资料，Agent 把其中的知识整理进对应的 wiki 页面，而不是每次提问时临时检索原始文档。",
  "## 2. 如何搭建",
  "先准备一个 Markdown 仓库作为 wiki 根目录，再写一份 Schema 文件约定页面结构，最后让 Agent 按 ingest / query / lint 三个流程工作。",
  "```bash\nmkdir wiki && cd wiki && git init\n```",
  "## 3. 三个 Agent",
  "Ingest Agent 负责把新资料写进页面；Query Agent 负责基于 wiki 回答问题并回填；Lint Agent 定期检查矛盾、过期与孤立页面，保持 wiki 健康。",
  "## 4. MVP 顺序",
  "第一周只做 ingest 与手动 query；第二周加入 lint；第三周再考虑自动化触发与多来源合并，不要一开始就追求全自动。"
].join("\n");

test("long QA: every answer section becomes a fragment; a missing section triggers one feedback retry", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertItem(env.db, {
    id: "item_wiki",
    type: "conversation",
    title: "llmwiki 是什么？如何搭建",
    capturedAt: T(0),
    question: "llmwiki 是什么？如何搭建",
    markdown: LONG_ANSWER,
    conversationId: "conv_wiki"
  });
  const fragments = sectionFragments(LONG_ANSWER, "LLM Wiki", "item_wiki").filter((fragment) => fragment.source_section);
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_wiki"], { item_wiki: "strong" })),
    replay.extract("item_wiki", { fragments, removed: [{ source_section: null, reason: "boilerplate" }] }, (input) => Boolean(input.feedback?.length)),
    replay.extract("item_wiki", { fragments: fragments.slice(0, 1), removed: [{ source_section: null, reason: "boilerplate" }] }),
    replay.align(
      "item_wiki",
      alignment(
        fragments.map(() => "new:LLM Wiki"),
        { new_entries: [newEntry("LLM Wiki", { category: "知识管理" })] }
      )
    )
  ]);

  await runPipeline(env, gateway);

  const extracts = stepCalls(prompts, "extract", "item_wiki") as Array<{ turns: Array<{ answer: string }>; feedback: string[] | null }>;
  assert.equal(extracts.length, 2);
  assert.equal(extracts[0]!.turns[0]!.answer, LONG_ANSWER);
  assert.equal(extracts[0]!.feedback, null);
  const feedback = extracts[1]!.feedback!.join("\n");
  for (const heading of ["如何搭建", "三个 Agent", "MVP 顺序"]) assert.ok(feedback.includes(heading), `feedback names ${heading}`);
  const [align] = stepCalls(prompts, "align", "item_wiki") as Array<{ fragments: Array<{ fragment_id: string }> }>;
  assert.equal(align!.fragments.length, 4);
  const created = env.db.prepare("SELECT body_markdown FROM kb_entries WHERE name = 'LLM Wiki'").get() as { body_markdown: string };
  assert.deepEqual(
    parseSections(created.body_markdown).map((section) => section.heading),
    ["1. LLM Wiki 到底是什么？", "2. 如何搭建", "3. 三个 Agent", "4. MVP 顺序"]
  );
  assert.ok(created.body_markdown.includes("```bash\nmkdir wiki && cd wiki && git init\n```"), "code block kept");
  const raw = rawOutput(env, "item_wiki");
  assert.equal(raw.extract_retries, 1);
  assert.deepEqual(raw.missing_sections, []);
});

test("V1: a rewritten (non-verbatim) fragment is retried with feedback and the verbatim result is kept", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const content = recordedContent("new");
  insertItem(env.db, { id: "item_mcp_intro", title: "Introduction - Model Context Protocol", capturedAt: T(0), markdown: content });
  const verbatim = sectionFragments(content, "Model Context Protocol");
  const rewritten = structuredClone(verbatim);
  rewritten[0]!.markdown = "MCP 是一个开放协议，用来统一应用向大模型提供上下文的方式，类似 AI 应用的 USB-C 接口。";
  const align = alignment(
    verbatim.map(() => "new:Model Context Protocol"),
    { new_entries: [newEntry("Model Context Protocol")] }
  );
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_mcp_intro"], { item_mcp_intro: "strong" })),
    replay.extract("item_mcp_intro", { fragments: verbatim, removed: [] }, (input) => Boolean(input.feedback?.length)),
    replay.extract("item_mcp_intro", { fragments: rewritten, removed: [] }),
    replay.align("item_mcp_intro", align)
  ]);

  await runPipeline(env, gateway);

  const extracts = stepCalls(prompts, "extract", "item_mcp_intro");
  assert.equal(extracts.length, 2);
  assert.match(extracts[1]!.feedback![0]!, /What is MCP\?.*疑似改写/);
  const created = env.db.prepare("SELECT body_markdown FROM kb_entries WHERE name = 'Model Context Protocol'").get() as { body_markdown: string };
  assert.ok(created.body_markdown.includes("Think of MCP like a USB-C port"));
  assert.ok(!created.body_markdown.includes("开放协议"));
  const raw = rawOutput(env, "item_mcp_intro");
  assert.equal(raw.extract_retries, 1);
  assert.deepEqual(raw.rewritten_fragments, []);
});

const NOTE_ARTICLE = [
  "## 是什么",
  "LLM Wiki 让 Agent 把读到的资料持续整理进 wiki 页面，知识随时间累积，而不是每次提问都从原始文档里临时检索拼凑答案。",
  "## Obsidian 配置",
  "在 Obsidian 中打开 wiki 目录作为 vault，安装 Dataview 插件并开启 JavaScript 查询，就可以按标签浏览所有页面与反向链接。",
  "## 维护流程",
  "每次 ingest 之后运行一次 lint：检查页面之间的矛盾、标记过期结论、为孤立页面补充链接，保证整个 wiki 结构一致。"
].join("\n");

test("instructions: item note「剔除 X」lands in removed; fuzzy note and requirement are labeled; entry notes never reach ⑤", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_wiki", name: "LLM Wiki", body: "## 定义\n由 LLM 维护的 wiki。" });
  insertItem(env.db, { id: "item_wiki", title: "LLM Wiki 实践", capturedAt: T(0), markdown: NOTE_ARTICLE });
  insertNote(env.db, { id: "note_item", scope: "item", targetId: "item_wiki", text: "剔除 Obsidian 部分", createdAt: T(1) });
  insertNote(env.db, { id: "note_fuzzy", scope: "fuzzy", text: "维护流程只留摘要", createdAt: T(2) });
  insertNote(env.db, { id: "note_entry", scope: "entry", targetId: "kb_wiki", text: "词条备注不参与整理", createdAt: T(3) });
  const fragments = sectionFragments(NOTE_ARTICLE, "LLM Wiki").filter((fragment) => fragment.heading !== "Obsidian 配置");
  const removed = [{ source_section: "## Obsidian 配置", reason: "instruction" as const }];
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_wiki"], { item_wiki: "strong" })),
    ...steps("item_wiki", fragments, alignment(["kb_wiki", "kb_wiki"]), removed)
  ]);

  await runPipeline(env, gateway, { requirement: "多写对比" });

  const extracts = stepCalls(prompts, "extract", "item_wiki") as Array<{ instructions: Array<{ kind: string; text: string }> }>;
  assert.equal(extracts.length, 1, "removed sections count as handled");
  assert.deepEqual(extracts[0]!.instructions, [
    { kind: "item_note", text: "剔除 Obsidian 部分" },
    { kind: "fuzzy_note", text: "维护流程只留摘要" },
    { kind: "requirement", text: "多写对比" }
  ]);
  assert.ok(!JSON.stringify(kpCalls(prompts)).includes("词条备注不参与整理"));
  const body = String(entry(env.db, "kb_wiki")!.body_markdown);
  assert.ok(!body.includes("Obsidian"));
  assert.ok(body.includes("## 维护流程"));
  const raw = rawOutput(env, "item_wiki") as { extract: { removed: unknown[] }; missing_sections: string[] };
  assert.deepEqual(raw.extract.removed, removed);
  assert.deepEqual(raw.missing_sections, []);
  const notes = env.db.prepare("SELECT id, used_at FROM notes ORDER BY id").all() as Array<{ id: string; used_at: string | null }>;
  assert.deepEqual(
    notes.map((note) => [note.id, Boolean(note.used_at)]),
    [
      ["note_entry", false],
      ["note_fuzzy", true],
      ["note_item", true]
    ]
  );
});

test("V1: summarized=true without any instruction is a rewrite and gets one feedback retry", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const content = recordedContent("new");
  insertItem(env.db, { id: "item_mcp_intro", title: "Introduction - Model Context Protocol", capturedAt: T(0), markdown: content });
  const verbatim = sectionFragments(content, "Model Context Protocol");
  const summarized = structuredClone(verbatim);
  summarized[0] = { ...summarized[0]!, markdown: "MCP 是统一应用向大模型提供上下文的开放协议。", summarized: true };
  assert.deepEqual(checkExtract({ fragments: summarized, removed: [] }, [{ turnItemId: null, text: content }], true).problems, [], "allowed with instructions");
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_mcp_intro"], { item_mcp_intro: "strong" })),
    replay.extract("item_mcp_intro", { fragments: verbatim, removed: [] }, (input) => Boolean(input.feedback?.length)),
    replay.extract("item_mcp_intro", { fragments: summarized, removed: [] }),
    replay.align("item_mcp_intro", alignment(verbatim.map(() => "new:Model Context Protocol"), { new_entries: [newEntry("Model Context Protocol")] }))
  ]);

  await runPipeline(env, gateway);

  const extracts = stepCalls(prompts, "extract", "item_mcp_intro");
  assert.equal(extracts.length, 2);
  assert.match(extracts[1]!.feedback![0]!, /What is MCP\?.*summarized=true/);
  const created = env.db.prepare("SELECT body_markdown FROM kb_entries WHERE name = 'Model Context Protocol'").get() as { body_markdown: string };
  assert.ok(created.body_markdown.includes("Think of MCP like a USB-C port"));
  assert.equal(rawOutput(env, "item_mcp_intro").extract_retries, 1);
});

test("covered_by pointing at a dissimilar section is overridden: the fragment is appended, not dropped", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  insertSource(env.db, "kb_hitl", "item_C", ["legacy quote"]);
  const docs = sectionFragments(recordedContent("supplement"), "Human-in-the-loop");
  const { gateway } = createReplayGateway([
    replay.judge(learningJudge(["item_C"], { item_C: "strong" })),
    ...steps(
      "item_C",
      docs,
      alignment(docs.map((_, index) => (index === 0 ? (["kb_hitl", "u_0"] as [string, string]) : "kb_hitl")))
    )
  ]);

  await runPipeline(env, gateway);

  const sections = parseSections(String(entry(env.db, "kb_hitl")!.body_markdown));
  assert.equal(sections.filter((section) => section.id).length, docs.length, "the 'covered' fragment is appended too");
  assert.ok(sections.some((section) => section.markdown.includes(docs[0]!.markdown)));
  assert.equal(result(env.db, "item_C")!.decision, "supplement");
  const raw = rawOutput(env, "item_C") as { coverage_overridden: Array<{ fragment: string; section_id: string; ratio: number }> };
  assert.equal(raw.coverage_overridden.length, 1);
  assert.equal(raw.coverage_overridden[0]!.fragment, "f1");
  assert.equal(raw.coverage_overridden[0]!.section_id, "u_0");
  assert.ok(raw.coverage_overridden[0]!.ratio < 0.85);
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_hitl' AND item_id = 'item_C'").get() as { evidence: string };
  const evidence = JSON.parse(source.evidence) as Array<{ quote: string; section_id?: string }>;
  assert.equal(evidence[0]!.quote, "legacy quote", "existing evidence is merged, not overwritten");
  assert.equal(evidence.filter((row) => row.section_id).length, docs.length);
});

test("re-organizing an ingested item matches its own sections instead of appending them again", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  const docs = sectionFragments(recordedContent("supplement"), "Human-in-the-loop");
  const rules = [replay.judge(learningJudge(["item_C"], { item_C: "strong" })), ...steps("item_C", docs, alignment(docs.map(() => "kb_hitl")))];
  await runPipeline(env, createReplayGateway(rules).gateway);
  const before = entry(env.db, "kb_hitl")!;

  env.db.prepare("UPDATE items SET dirty = 1 WHERE id = 'item_C'").run();
  const second = createReplayGateway(rules);
  await runPipeline(env, second.gateway, { scope: "inbox_pending" });

  assert.equal(stepCalls(second.prompts, "align", "item_C").length, 1, "the item went through ⑤ again");
  const after = entry(env.db, "kb_hitl")!;
  assert.equal(after.body_markdown, before.body_markdown);
  assert.equal(after.patch_count, before.patch_count);
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_hitl' AND item_id = 'item_C'").get() as { evidence: string };
  assert.equal((JSON.parse(source.evidence) as unknown[]).length, docs.length);
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
});

test("V2: an invalid assignment is retried once, then the unit fails", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  const docs = sectionFragments(recordedContent("supplement"), "Human-in-the-loop");
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_C"], { item_C: "strong" })),
    ...steps(
      "item_C",
      docs,
      alignment(docs.map(() => ["kb_hitl", "s_missing"] as [string, string]))
    )
  ]);

  await runPipeline(env, gateway);

  const aligns = stepCalls(prompts, "align", "item_C");
  assert.equal(aligns.length, 2);
  assert.match(aligns[1]!.feedback![0]!, /s_missing/);
  assert.equal(itemStatus(env.db, "item_C").organize_status, "failed");
  assert.equal(entry(env.db, "kb_hitl")!.body_markdown, HITL_BODY);
});

test("user_edited entry: sections are appended after the user's text and the summary is kept", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env, { hitlUserEdited: true });
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  const docs = sectionFragments(recordedContent("supplement"), "Human-in-the-loop");
  const { gateway } = createReplayGateway([
    replay.judge(learningJudge(["item_C"], { item_C: "strong" })),
    ...steps(
      "item_C",
      docs,
      alignment(docs.map(() => "kb_hitl"))
    )
  ]);

  await runPipeline(env, gateway);

  const hitl = entry(env.db, "kb_hitl")!;
  const sections = parseSections(String(hitl.body_markdown));
  assert.deepEqual(sections.slice(0, 3), parseSections(HITL_BODY), "user text is untouched");
  assert.equal(sections.filter((section) => section.id).length, docs.length);
  assert.equal(hitl.summary, "人工审批节点");
  assert.equal(hitl.user_edited, 1);
});

test("⑦ scope=entry restructures the entry without changing section text", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const body = "## 用法\n<!-- section:s_use src:item_x -->\n调用 interrupt()。\n\n## 定义\n<!-- section:s_def src:item_x -->\n人工审批节点。";
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", body, patchCount: 8 });
  const { gateway } = createReplayGateway([replay.restructure("kb_hitl", { order: ["s_def", "s_use"], headings: [], merge: [], summary: "人工审批节点" })]);

  const { runId, result: run } = await runPipeline(env, gateway, { scope: "entry", entryIds: ["kb_hitl"] });

  const hitl = entry(env.db, "kb_hitl")!;
  assert.deepEqual(
    parseSections(String(hitl.body_markdown)).map((section) => [section.id, section.markdown]),
    [
      ["s_def", "人工审批节点。"],
      ["s_use", "调用 interrupt()。"]
    ]
  );
  assert.equal(hitl.patch_count, 0);
  assert.equal(run.stats.kb.entriesRewritten, 1);
  assert.ok(runJobs(env.db, runId).some((job) => job.kind === "entry_rewrite" && job.status === "rewritten"));
});

test("a failing item does not block the batch; retry processes only the failed item", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const [, , ...docsSteps] = langGraphSteps();
  const broken = createReplayGateway([judgeAll(), replay.extract("item_B", { fragments: "nonsense" }), ...docsSteps]);

  const first = await runPipeline(env, broken.gateway);

  assert.equal(first.result.status, "completed");
  assert.equal(itemStatus(env.db, "item_B").organize_status, "failed");
  assert.equal(itemStatus(env.db, "item_B2").organize_status, "failed");
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  assert.equal(first.result.stats.items.failed, 2);
  const failedJob = runJobs(env.db, first.runId).find((job) => job.target_id === "item_B")!;
  assert.equal(failedJob.status, "failed");
  assert.ok(failedJob.error);

  const fixed = createReplayGateway([judgeAll(), ...langGraphSteps()]);
  const retry = await runPipeline(env, fixed.gateway, { trigger: "retry", itemIds: ["item_B", "item_B2"] });

  assert.equal(itemStatus(env.db, "item_B").organize_status, "ingested");
  assert.equal(kpCalls(fixed.prompts, "item_C").length, 0);
  assert.equal(retry.result.stats.items.total, 2);
  const retriedJob = runJobs(env.db, retry.runId).find((job) => job.target_id === "item_B")!;
  assert.equal(retriedJob.attempts, 2);
});

test("daily token limit pauses the run and leaves unfinished items pending", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const { gateway } = createReplayGateway([judgeAll(), ...langGraphSteps()], { limit: 1 });

  const { runId, result: run } = await runPipeline(env, gateway);

  assert.equal(run.status, "paused");
  assert.equal(itemStatus(env.db, "item_C").organize_status, "pending");
  assert.ok(runJobs(env.db, runId).some((job) => job.status === "pending"));
});

test("re-running the same batch skips every item by input_hash (no ③/⑤ calls)", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const rules = [judgeAll(), ...langGraphSteps()];
  await runPipeline(env, createReplayGateway(rules).gateway);
  const patchCount = entry(env.db, "kb_hitl")!.patch_count;

  env.db.prepare("UPDATE items SET organize_status = 'pending'").run();
  const second = createReplayGateway(rules);
  const { result: run } = await runPipeline(env, second.gateway);

  assert.equal(run.stats.items.skipped, 3);
  assert.equal(kpCalls(second.prompts).length, 0);
  assert.equal(
    second.prompts.filter((call) => Array.isArray((call.input as { timeline?: unknown }).timeline)).length,
    0,
    "judge served from the episode cache"
  );
  assert.equal(entry(env.db, "kb_hitl")!.patch_count, patchCount);
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");

  env.db.prepare("UPDATE kb_entries SET deleted_at = '2026-10-05T00:00:00.000Z'").run();
  env.db.prepare("UPDATE items SET organize_status = 'pending'").run();
  const third = createReplayGateway(rules);
  const { result: rerun } = await runPipeline(env, third.gateway);
  assert.equal(rerun.stats.items.skipped, 0, "results whose entries were deleted are not reused");
  assert.ok(kpCalls(third.prompts).length > 0);
});
