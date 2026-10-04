import assert from "node:assert/strict";
import { test } from "node:test";
import { runJobs } from "../../src/domains/organize/run-store";
import {
  createEnv,
  createReplayGateway,
  entry,
  insertEntry,
  insertItem,
  insertNote,
  insertSelection,
  insertSource,
  itemStatus,
  output,
  recordedContent,
  recordedTurns,
  replay,
  result,
  runPipeline,
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

function learningJudge(candidates: string[], engagement: Record<string, "weak" | "medium" | "strong">, patch: Record<string, unknown> = {}) {
  return output("learning_judge", "learning", {
    candidate_item_ids: candidates,
    item_engagement: Object.entries(engagement).map(([item_id, level]) => ({ item_id, engagement: level })),
    ...patch
  });
}

function kpCalls(prompts: Array<{ input: unknown }>, itemId?: string) {
  return prompts.filter((call) => {
    const input = call.input as { item?: { item_id?: string }; timeline?: unknown };
    return input?.item?.item_id && (!itemId || input.item.item_id === itemId);
  });
}

test("③ learning episode → ⑤ supplement + conversation thread → ⑥ patches and sources", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  setLearnerProfile(env.db);
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_B", "item_B2", "item_C"], { item_B: "strong", item_B2: "strong", item_C: "strong" })),
    ...steps("item_B", output("knowledge_processing", "conversation-thread")),
    ...steps("item_C", output("knowledge_processing", "supplement"))
  ]);

  const { runId, result: run } = await runPipeline(env, gateway);

  assert.equal(run.status, "completed");
  assert.equal(run.stats.items.total, 3);
  assert.equal(run.stats.items.ingested, 3);
  assert.equal(run.stats.decisions.supplement, 2);
  assert.equal(run.stats.episodes.learning, 1);
  assert.ok(run.tokens > 0);
  assert.equal(run.model, "replay");
  for (const id of ["item_B", "item_B2", "item_C"]) assert.equal(itemStatus(env.db, id).organize_status, "ingested");

  const kpInputs = kpCalls(prompts);
  assert.equal(kpCalls(prompts, "item_B2").length, 0, "follow-up turn is processed with its thread");
  const thread = kpInputs.find((call) => (call.input as { item: { item_id: string } }).item.item_id === "item_B")!.input as {
    item: { turns: Array<{ turn_item_id: string }> };
    related_entries: Array<{ entry_id: string }>;
  };
  assert.deepEqual(
    thread.item.turns.map((turn) => turn.turn_item_id),
    ["item_B", "item_B2"]
  );
  assert.ok(thread.related_entries.some((related) => related.entry_id === "kb_checkpoint"));

  const hitl = entry(env.db, "kb_hitl")!;
  assert.ok(Number(hitl.patch_count) >= 1);
  assert.notEqual(hitl.body_markdown, HITL_BODY);
  const sources = env.db.prepare("SELECT entry_id, item_id FROM kb_entry_sources ORDER BY entry_id, item_id").all() as Array<{
    entry_id: string;
    item_id: string;
  }>;
  assert.ok(sources.some((row) => row.entry_id === "kb_hitl" && row.item_id === "item_C"));
  assert.ok(sources.some((row) => row.entry_id === "kb_checkpoint" && row.item_id === "item_B"));

  const stored = result(env.db, "item_C")!;
  assert.equal(stored.decision, "supplement");
  assert.equal(stored.run_id, runId);
  assert.ok(String(stored.target_entry_ids).includes("kb_hitl"));
  const episode = env.db.prepare("SELECT status, prompt_version, judge_output FROM episodes").get() as {
    status: string;
    prompt_version: string;
    judge_output: string;
  };
  assert.equal(episode.status, "learning");
  assert.ok(episode.judge_output.includes("LangGraph"));
  assert.ok(runJobs(env.db, runId).every((job) => job.status === "ingested"));
});

test("③ non-learning episode rejects items; a noted item is still forced into ⑤", async (t) => {
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
  const { gateway, prompts } = createReplayGateway([
    replay.judge(output("learning_judge", "non-learning")),
    ...steps("item_vite_port", output("knowledge_processing", "reject-transient"))
  ]);

  const { result: run } = await runPipeline(env, gateway);

  assert.equal(result(env.db, "item_news")!.decision, "not_learning");
  assert.equal(itemStatus(env.db, "item_news").organize_status, "rejected");
  assert.equal(kpCalls(prompts, "item_news").length, 0);
  const forced = kpCalls(prompts, "item_vite_port")[0]!.input as { item: { user_note: string | null; engagement: string } };
  assert.equal(forced.item.user_note, "以后端口冲突就这么处理");
  assert.equal(forced.item.engagement, "strong");
  assert.equal(result(env.db, "item_vite_port")!.reject_reason, "transient");
  assert.equal(stepCalls(prompts, "extract").length, 0, "S1 reject stops before extraction");
  assert.equal(run.stats.decisions.notLearning, 1);
  assert.equal(run.stats.decisions.reject, 1);
  const note = env.db.prepare("SELECT used_at FROM notes WHERE id = 'note_vite'").get() as { used_at: string | null };
  assert.ok(note.used_at, "notes fed to ⑤ are marked used");
});

test("③ uncertain band raises τ: weak engagement + 0.78 is rejected by the code fallback", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertItem(env.db, {
    id: "item_mcp_intro",
    title: "Introduction - Model Context Protocol",
    url: "https://modelcontextprotocol.io/introduction",
    capturedAt: T(0),
    markdown: recordedContent("new")
  });
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_mcp_intro"], { item_mcp_intro: "weak" }, { confidence: 0.5 })),
    ...steps("item_mcp_intro", output("knowledge_processing", "new"))
  ]);

  await runPipeline(env, gateway);

  const input = kpCalls(prompts, "item_mcp_intro")[0]!.input as { episode: { uncertain: boolean } };
  assert.equal(input.episode.uncertain, true);
  const stored = result(env.db, "item_mcp_intro")!;
  assert.equal(stored.decision, "reject");
  assert.equal(stored.reject_reason, "low_information");
  const detail = JSON.parse(String(stored.output)) as { raw: { triage: { decision: string } }; fallback: { overridden: boolean; tau: number } };
  assert.equal(detail.raw.triage.decision, "proceed", "raw model output is kept for calibration");
  assert.equal(detail.fallback.overridden, true);
  assert.equal(detail.fallback.tau, 0.8);
  assert.equal(stepCalls(prompts, "extract").length, 0, "τ fallback stops before extraction");
  assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM kb_entries").get() as { n: number }).n, 0);
});

test("③ high confidence + medium engagement: ⑤ new creates an entry, summary vectors are indexed", async (t) => {
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
  const { gateway } = createReplayGateway([
    replay.judge(learningJudge(["item_mcp_intro"], { item_mcp_intro: "medium" }, { related_exploration: ["Function Calling"] })),
    ...steps("item_mcp_intro", output("knowledge_processing", "new"))
  ]);

  const { result: run } = await runPipeline(env, gateway);

  assert.equal(run.stats.kb.entriesCreated, 1);
  const created = env.db.prepare("SELECT id, name, kind FROM kb_entries WHERE name = 'Model Context Protocol'").get() as {
    id: string;
    name: string;
    kind: string;
  };
  assert.ok(created);
  const owners = env.db.prepare("SELECT DISTINCT owner_type FROM chunks WHERE owner_id = ?").all(created.id) as Array<{ owner_type: string }>;
  assert.deepEqual(owners.map((row) => row.owner_type).sort(), ["entry", "entry_name", "entry_summary"]);
  assert.ok(env.searchIndex.vectorStore.size() > 0);
});

test("⑤ duplicate adds a source without touching the body; a highlighted item is re-checked point by point", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const body = "## 定义\n先粗召回再用 cross-encoder 重排。";
  insertEntry(env.db, { id: "kb_rerank", name: "RAG 重排", aliases: ["Rerank", "重排序"], kind: "method", body });
  insertItem(env.db, {
    id: "item_rerank_blog",
    title: "RAG 优化：为什么要加一层 Rerank",
    url: "https://example-blog.dev/rag-rerank",
    capturedAt: T(0),
    markdown: recordedContent("duplicate")
  });
  insertSelection(env.db, "item_rerank_blog", "再用 cross-encoder 重排模型对「问题-片段」逐对打分", T(-1));
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_rerank_blog"], { item_rerank_blog: "weak" }, { related_exploration: ["Rerank"] })),
    ...steps("item_rerank_blog", output("knowledge_processing", "duplicate"))
  ]);

  await runPipeline(env, gateway);

  assert.equal(stepCalls(prompts, "compose", "item_rerank_blog").length, 1, "S1 duplicate on a highlighted item still runs compose");
  assert.equal(result(env.db, "item_rerank_blog")!.decision, "duplicate");
  assert.equal(itemStatus(env.db, "item_rerank_blog").organize_status, "ingested");
  assert.equal(entry(env.db, "kb_rerank")!.body_markdown, body);
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_rerank' AND item_id = 'item_rerank_blog'").get() as {
    evidence: string;
  };
  assert.ok(source.evidence.includes("cross-encoder"));
});

test("adopt mode: rejected item selected manually skips judge and τ, legacy pattern kind maps to 设计模式", async (t) => {
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
  const { gateway, prompts } = createReplayGateway([
    ...steps("item_react_post", output("knowledge_processing", "adopt", { value_score: 0.1 }))
  ]);

  const { result: run } = await runPipeline(env, gateway, { scope: "inbox_selected", itemIds: ["item_react_post"] });

  assert.equal(prompts.filter((call) => Array.isArray((call.input as { timeline?: unknown }).timeline)).length, 0, "direct path skips ③");
  const stored = result(env.db, "item_react_post")!;
  assert.equal(stored.decision, "new");
  assert.equal(stored.override, "adopt");
  assert.equal(stored.route, "llm");
  const created = env.db.prepare("SELECT kind FROM kb_entries WHERE name = 'ReAct'").get() as { kind: string };
  assert.equal(created.kind, "设计模式");
  assert.equal(run.stats.decisions.new, 1);
});

test("long text: S1 sees an excerpt + outline, every section reaches S2 across chunks", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  const filler = (title: string) => `## ${title}\n${"LangGraph persistence keeps graph state between steps so runs can resume. ".repeat(450)}`;
  const content = [recordedContent("supplement"), filler("Appendix A"), filler("Appendix B"), filler("Appendix C")].join("\n\n");
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: content });
  const { gateway, prompts } = createReplayGateway([replay.judge(learningJudge(["item_C"], { item_C: "strong" })), ...steps("item_C", output("knowledge_processing", "supplement"))]);

  await runPipeline(env, gateway);

  const [triage] = stepCalls(prompts, "triage", "item_C") as Array<{ item: { excerpt: string; outline: string[] } }>;
  assert.ok(triage!.item.excerpt.length < content.length / 2, "triage sees an excerpt");
  assert.ok(triage!.item.outline.includes("## Appendix C"), "triage sees the full outline");
  const extracts = stepCalls(prompts, "extract", "item_C") as Array<{ chunk: { index: number; total: number; text: string } }>;
  assert.ok(extracts.length >= 2, `expected several chunks, got ${extracts.length}`);
  assert.equal(extracts[0]!.chunk.total, extracts.length);
  for (const title of ["Appendix A", "Appendix B", "Appendix C"]) assert.ok(extracts.some((call) => call.chunk.text.includes(`## ${title}`)), `${title} reaches S2`);
  const stored = result(env.db, "item_C")!;
  assert.equal(stored.route, "llm");
  assert.equal(stored.decision, "supplement");
});

test("S5: compose missing a core point is retried with feedback and the better result is kept", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  const [triage, extract, , compose] = steps("item_C", output("knowledge_processing", "supplement"));
  const full = compose!.output as { concepts: Array<{ point_ids: string[] }> };
  const partial = structuredClone(full);
  partial.concepts[0]!.point_ids = partial.concepts[0]!.point_ids.slice(0, 1);
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_C"], { item_C: "strong" })),
    triage!,
    extract!,
    replay.extract("item_C", { points: [] }),
    replay.compose("item_C", full, (input) => Boolean(input.feedback?.length)),
    replay.compose("item_C", partial)
  ]);

  await runPipeline(env, gateway);

  const calls = stepCalls(prompts, "compose", "item_C");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.feedback, null);
  assert.match(calls[1]!.feedback![0]!, /p2/);
  const detail = JSON.parse(String(result(env.db, "item_C")!.output)) as { raw: { compose_retries: number; missing_after_retry: string[] } };
  assert.equal(detail.raw.compose_retries, 1);
  assert.deepEqual(detail.raw.missing_after_retry, []);
  const source = env.db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = 'kb_hitl' AND item_id = 'item_C'").get() as { evidence: string };
  const evidence = JSON.parse(source.evidence) as Array<{ point?: string; importance?: string }>;
  assert.equal(evidence.length, full.concepts[0]!.point_ids.length);
  assert.ok(evidence.every((item) => item.point && item.importance === "core"), "points are persisted with the evidence");
});

test("S1 duplicate without user marks stops before extraction", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_rerank", name: "RAG 重排", aliases: ["Rerank"], body: "## 定义\n先粗召回再用 cross-encoder 重排。" });
  insertItem(env.db, { id: "item_rerank_blog", title: "RAG 优化：为什么要加一层 Rerank", capturedAt: T(0), markdown: recordedContent("supplement") });
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_rerank_blog"], { item_rerank_blog: "medium" }, { related_exploration: ["Rerank"] })),
    ...steps("item_rerank_blog", output("knowledge_processing", "duplicate"))
  ]);

  await runPipeline(env, gateway);

  assert.equal(result(env.db, "item_rerank_blog")!.decision, "duplicate");
  assert.equal(stepCalls(prompts, "extract").length, 0);
  assert.equal(stepCalls(prompts, "compose").length, 0);
});

test("user_edited entry: supplement goes to 整理建议 and the summary is kept", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env, { hitlUserEdited: true });
  insertItem(env.db, { id: "item_C", title: "Human-in-the-loop - LangGraph Docs", capturedAt: T(0), markdown: recordedContent("supplement") });
  insertSelection(env.db, "item_C", "The interrupt() function pauses graph execution at a specific node", T(-1));
  const { gateway, prompts } = createReplayGateway([
    replay.judge(learningJudge(["item_C"], { item_C: "strong" })),
    ...steps("item_C", output("knowledge_processing", "supplement"))
  ]);

  await runPipeline(env, gateway);

  const input = kpCalls(prompts, "item_C")[0]!.input as { item: { user_highlights: string[] } };
  assert.deepEqual(input.item.user_highlights, ["The interrupt() function pauses graph execution at a specific node"]);
  const hitl = entry(env.db, "kb_hitl")!;
  assert.ok(String(hitl.body_markdown).startsWith(HITL_BODY), "user text is untouched");
  assert.ok(String(hitl.body_markdown).includes("## 整理建议"));
  assert.equal(hitl.summary, "人工审批节点");
});

test("⑦ stale entry is rewritten from live evidence; missing evidence makes it an orphan", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  insertEntry(env.db, { id: "kb_lonely", name: "Lonely", body: "## 定义\n只有一个来源。" });
  insertItem(env.db, { id: "item_A", title: "Persistence - LangGraph Docs", capturedAt: T(0), markdown: "persistence", status: "ingested" });
  insertItem(env.db, { id: "item_B", type: "conversation", title: "checkpoint 和 interrupt", capturedAt: T(1), markdown: "answer", status: "ingested" });
  insertSource(env.db, "kb_checkpoint", "item_A", ["LangGraph has a built-in persistence layer"]);
  insertSource(env.db, "kb_checkpoint", "item_B", ["interrupt 依赖 checkpoint"]);
  insertSource(env.db, "kb_lonely", "item_A", ["only source"]);
  env.db.prepare("UPDATE items SET deleted_at = ? WHERE id = 'item_A'").run("2026-10-02T10:00:00.000Z");
  const { gateway, prompts } = createReplayGateway([replay.rewrite("kb_checkpoint", output("entry_rewrite", "stale"))]);

  const { runId, result: run } = await runPipeline(env, gateway);

  const rewriteInput = prompts.find((call) => (call.input as { entry?: { entry_id: string } }).entry?.entry_id === "kb_checkpoint")!.input as {
    trigger: string;
    evidence: Array<{ item_id: string }>;
  };
  assert.equal(rewriteInput.trigger, "stale");
  assert.deepEqual([...new Set(rewriteInput.evidence.map((evidence) => evidence.item_id))], ["item_B"]);
  const checkpoint = entry(env.db, "kb_checkpoint")!;
  assert.equal(checkpoint.stale, 0);
  assert.equal(checkpoint.patch_count, 0);
  assert.ok(String(checkpoint.body_markdown).includes("MemorySaver"));
  const lonely = entry(env.db, "kb_lonely")!;
  assert.equal(lonely.orphan, 1);
  assert.equal(lonely.stale, 0);
  assert.equal(run.stats.kb.entriesRewritten, 1);
  assert.ok(runJobs(env.db, runId).some((job) => job.kind === "entry_rewrite" && job.status === "rewritten"));
});

test("⑦ manual rewrite of a user_edited entry appends 重写建议 instead of overwriting", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env, { hitlUserEdited: true });
  insertItem(env.db, { id: "item_C", title: "HITL docs", capturedAt: T(0), markdown: "hitl", status: "ingested" });
  insertSource(env.db, "kb_hitl", "item_C", ["The interrupt() function pauses graph execution"]);
  const { gateway, prompts } = createReplayGateway([replay.rewrite("kb_hitl", output("entry_rewrite", "manual-patched"))]);

  await runPipeline(env, gateway, { scope: "entry", entryIds: ["kb_hitl"], requirement: "按 定义 / 实现 组织" });

  const input = prompts.find((call) => (call.input as { entry?: unknown }).entry)!.input as { trigger: string; requirement: string | null };
  assert.equal(input.trigger, "manual");
  assert.equal(input.requirement, "按 定义 / 实现 组织");
  const hitl = entry(env.db, "kb_hitl")!;
  assert.ok(String(hitl.body_markdown).startsWith(HITL_BODY));
  assert.ok(String(hitl.body_markdown).includes("重写建议"));
});

test("a failing item does not block the batch; retry processes only the failed item", async (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  seedLangGraphKb(env);
  seedLangGraphItems(env);
  const judge = replay.judge(learningJudge(["item_B", "item_B2", "item_C"], { item_B: "strong", item_B2: "strong", item_C: "strong" }));
  const broken = createReplayGateway([
    judge,
    replay.triage("item_B", { decision: "nonsense" }),
    ...steps("item_C", output("knowledge_processing", "supplement"))
  ]);

  const first = await runPipeline(env, broken.gateway);

  assert.equal(first.result.status, "completed");
  assert.equal(itemStatus(env.db, "item_B").organize_status, "failed");
  assert.equal(itemStatus(env.db, "item_B2").organize_status, "failed");
  assert.equal(itemStatus(env.db, "item_C").organize_status, "ingested");
  assert.equal(first.result.stats.items.failed, 2);
  const failedJob = runJobs(env.db, first.runId).find((job) => job.target_id === "item_B")!;
  assert.equal(failedJob.status, "failed");
  assert.ok(failedJob.error);

  const fixed = createReplayGateway([judge, ...steps("item_B", output("knowledge_processing", "conversation-thread"))]);
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
  const { gateway } = createReplayGateway(
    [
      replay.judge(learningJudge(["item_B", "item_B2", "item_C"], { item_B: "strong", item_B2: "strong", item_C: "strong" })),
      ...steps("item_B", output("knowledge_processing", "conversation-thread")),
      ...steps("item_C", output("knowledge_processing", "supplement"))
    ],
    { limit: 1 }
  );

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
  const rules = [
    replay.judge(learningJudge(["item_B", "item_B2", "item_C"], { item_B: "strong", item_B2: "strong", item_C: "strong" })),
    ...steps("item_B", output("knowledge_processing", "conversation-thread")),
    ...steps("item_C", output("knowledge_processing", "supplement"))
  ];
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
});
