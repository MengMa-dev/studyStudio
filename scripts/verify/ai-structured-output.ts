/**
 * M0 verification: AI SDK `generateObject` + Zod discriminated union against the confirmed task models (06).
 * Each model is tried with native structured output first; on failure, once more in JSON mode with the
 * schema in the prompt and local validation (the gateway fallback planned for M4).
 * Usage: npm run verify:ai [-- --only=mock,ollama,gemini,openrouter,groq] [--full]
 *   --full  runs every sample on cloud models too (default: cloud models only run the first sample, to save free quota)
 * Reads ai-seed.json and secrets.json from STUDY_STUDIO_DATA_DIR (default ./StudyStudioData).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const full = process.argv.includes("--full");

const evidence = z.object({ quote: z.string() });
const concept = z.object({
  name: z.string(),
  match: z.string().describe('已有词条 entry_id，或 "new"'),
  summary: z.string().nullable(),
  evidence: z.array(evidence)
});
const patchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append_to_section"), section: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("add_section"), after: z.string(), heading: z.string(), markdown: z.string() }),
  z.object({ op: z.literal("replace_section"), section: z.string(), markdown: z.string() })
]);
const common = { item_id: z.string(), value_score: z.number().min(0).max(1), reason: z.string() };

export const knowledgeDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ ...common, decision: z.literal("new"), item_summary: z.string(), item_points: z.array(z.string()), concepts: z.array(concept).min(1) }),
  z.object({
    ...common,
    decision: z.literal("supplement"),
    item_summary: z.string(),
    item_points: z.array(z.string()),
    concepts: z.array(concept.extend({ patch_ops: z.array(patchOp) })).min(1)
  }),
  z.object({ ...common, decision: z.literal("duplicate"), target_entry_ids: z.array(z.string()).min(1) }),
  z.object({ ...common, decision: z.literal("reject"), reject_reason: z.enum(["off_topic", "low_information", "navigational", "transient"]) })
]);
type KnowledgeDecision = z.infer<typeof knowledgeDecisionSchema>;

const LEARNER_PROFILE = { role: "前端开发", learning_focus: ["Agent 架构"] };

const SYSTEM = `你是个人知识库的整理助手。根据输入的收集条目与已有词条，判断条目是否值得入库，并按 decision 输出 JSON：
- new：知识库中没有的知识，输出 item_summary、item_points、concepts（match="new"）。
- supplement：给已有词条补充新要点，concepts[].match 填已有 entry_id，patch_ops 只写增量（append_to_section / add_section / replace_section）。
- duplicate：已被已有词条覆盖，target_entry_ids 填被覆盖的词条。
- reject：无入库价值，reject_reason 取 off_topic / low_information / navigational / transient（一次性信息，如某个报错的临时解法）。
value_score 为 0–1 的入库价值。学习者档案只能加分，不能作为 reject 理由。只输出 JSON。`;

const SAMPLES = [
  {
    id: "item_hitl",
    expected: "supplement",
    input: {
      learner_profile: LEARNER_PROFILE,
      item: {
        item_id: "item_hitl",
        type: "webpage",
        source_kind: "official_doc",
        title: "Human-in-the-loop - LangGraph Docs",
        content:
          "## Interrupt\ninterrupt() pauses graph execution and surfaces a value to the client. Resuming requires a checkpointer: the graph state is persisted at each super-step, so the run can continue from the saved checkpoint with Command(resume=...).\n## Checkpointer libraries\nMemorySaver for testing, SqliteSaver and PostgresSaver for production.",
        user_note: "HITL 依赖 checkpoint 持久化",
        engagement: "strong"
      },
      related_entries: [
        {
          entry_id: "kb_hitl",
          name: "Human-in-the-loop",
          aliases: ["HITL"],
          summary: "在 Agent 执行中插入人工审批节点。",
          outline: ["## 定义", "## 实现方式", "## 常见场景"],
          body_markdown: "## 定义\n在图执行中插入人工审批。\n## 实现方式\n在节点中等待用户输入。\n## 常见场景\n工具调用前审批。"
        }
      ]
    }
  },
  {
    id: "item_npm",
    expected: "reject",
    input: {
      learner_profile: LEARNER_PROFILE,
      item: {
        item_id: "item_npm",
        type: "conversation",
        source_kind: "ai_answer",
        title: "npm install 报 EACCES",
        content: "问：npm install -g 报 EACCES permission denied 怎么办？\n答：临时可以 sudo chown -R $(whoami) ~/.npm 后重试。",
        engagement: "weak"
      },
      related_entries: []
    }
  }
] as const;

/** OpenAI-style strict JSON Schema requires an object at the top level, so the union is wrapped for openai-compatible providers. */
const wrappedDecisionSchema = z.object({ result: knowledgeDecisionSchema });

type Mode = "structured" | "json";
type Target = { task: string; providerId: string; modelId: string; cloud: boolean; wrap: boolean; model: (mode: Mode) => LanguageModel };

/** Deterministic offline model: answers each sample with its expected decision. */
function mockModel(): LanguageModelV4 {
  const answers: Record<string, KnowledgeDecision> = {
    item_hitl: {
      item_id: "item_hitl",
      decision: "supplement",
      value_score: 0.8,
      reason: "已有 HITL 词条，缺少与 checkpoint 的关系",
      item_summary: "interrupt() 暂停图执行，恢复依赖 checkpointer 持久化。",
      item_points: ["interrupt 依赖 checkpoint 恢复"],
      concepts: [
        {
          name: "Human-in-the-loop",
          match: "kb_hitl",
          summary: null,
          evidence: [{ quote: "Resuming requires a checkpointer" }],
          patch_ops: [{ op: "append_to_section", section: "## 实现方式", markdown: "恢复执行依赖 checkpointer 持久化的状态。" }]
        }
      ]
    },
    item_npm: { item_id: "item_npm", decision: "reject", value_score: 0.1, reason: "一次性的报错解法", reject_reason: "transient" }
  };
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "deterministic",
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions) {
      const prompt = JSON.stringify(options.prompt);
      const answer = Object.entries(answers).find(([id]) => prompt.includes(id))?.[1];
      return {
        content: [{ type: "text", text: JSON.stringify(answer ?? {}) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: prompt.length, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        warnings: []
      };
    },
    async doStream() {
      throw new Error("mock model does not stream");
    }
  };
}

type Seed = {
  providers: { id: string; type: string; base_url: string }[];
  task_models: { task: string; provider_id: string; model: string; fallback_provider_id: string | null; fallback_model: string | null }[];
};

async function loadTargets(): Promise<Target[]> {
  const seed = JSON.parse(await readFile(join(dataDir, "ai-seed.json"), "utf8")) as Seed;
  const secrets = JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8").catch(() => "{}")) as { providers?: Record<string, { apiKey: string }> };
  const factory = (providerId: string, modelId: string): Target["model"] => {
    const provider = seed.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`provider ${providerId} missing in ai-seed.json`);
    const apiKey = secrets.providers?.[providerId]?.apiKey;
    if (provider.type === "ollama") return () => createOllama({ baseURL: provider.base_url })(modelId);
    if (provider.type === "google") return () => createGoogleGenerativeAI({ apiKey, baseURL: provider.base_url })(modelId);
    return (mode) =>
      createOpenAICompatible({ name: providerId, baseURL: provider.base_url, apiKey, supportsStructuredOutputs: mode === "structured" })(modelId);
  };
  const targets: Target[] = [{ task: "mock", providerId: "mock", modelId: "deterministic", cloud: false, wrap: false, model: () => mockModel() }];
  for (const row of seed.task_models.filter((item) => item.task !== "embedding")) {
    const pairs: [string, string, string][] = [[`${row.task}`, row.provider_id, row.model]];
    if (row.fallback_provider_id && row.fallback_model) pairs.push([`${row.task} (fallback)`, row.fallback_provider_id, row.fallback_model]);
    for (const [task, providerId, modelId] of pairs) {
      if (targets.some((target) => target.providerId === providerId && target.modelId === modelId)) continue;
      const type = seed.providers.find((item) => item.id === providerId)?.type;
      targets.push({ task, providerId, modelId, cloud: type !== "ollama", wrap: type === "openai-compatible", model: factory(providerId, modelId) });
    }
  }
  return targets.filter((target) => !only || only.includes(target.providerId));
}

type Outcome = { ok: boolean; decision?: string; ms: number; tokens?: number; error?: string };

async function attempt(target: Target, sample: (typeof SAMPLES)[number], mode: Mode): Promise<Outcome> {
  const started = Date.now();
  const schema = target.wrap ? wrappedDecisionSchema : knowledgeDecisionSchema;
  const schemaHint = mode === "json" ? `\n\n输出必须符合以下 JSON Schema：\n${JSON.stringify(z.toJSONSchema(schema))}` : "";
  try {
    const result = await generateObject({
      model: target.model(mode),
      schema: schema as z.ZodType<KnowledgeDecision | { result: KnowledgeDecision }>,
      system: SYSTEM + (target.wrap ? "\n结果放在 result 字段中。" : "") + schemaHint,
      prompt: JSON.stringify(sample.input, null, 2),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(target.providerId === "ollama" ? 300_000 : 120_000)
    });
    const object = "result" in result.object ? result.object.result : result.object;
    return { ok: true, decision: object.decision, ms: Date.now() - started, tokens: result.usage.totalTokens };
  } catch (error) {
    const { message, statusCode, responseBody } = error as Error & { statusCode?: number; responseBody?: string };
    const detail = [statusCode, message, responseBody].filter(Boolean).join(" ").replace(/\s+/g, " ");
    return { ok: false, ms: Date.now() - started, error: detail.slice(0, 400) };
  }
}

const targets = await loadTargets();
let failures = 0;
for (const target of targets) {
  const samples = target.cloud && !full ? SAMPLES.slice(0, 1) : SAMPLES;
  for (const sample of samples) {
    let mode: Mode = "structured";
    let outcome = await attempt(target, sample, mode);
    if (!outcome.ok && target.providerId !== "mock") {
      const structuredError = outcome.error;
      mode = "json";
      outcome = await attempt(target, sample, mode);
      if (!outcome.ok) outcome.error = `structured: ${structuredError} | json: ${outcome.error}`;
      else outcome.error = `structured failed: ${structuredError}`;
    }
    if (!outcome.ok) failures += 1;
    const verdict = outcome.ok ? (outcome.decision === sample.expected ? "PASS" : "PASS*") : "FAIL";
    const line = `${verdict.padEnd(5)} ${target.task.padEnd(32)} ${`${target.providerId}/${target.modelId}`.padEnd(52)} ${sample.id.padEnd(9)} mode=${mode.padEnd(10)} decision=${(outcome.decision ?? "-").padEnd(10)} expected=${sample.expected.padEnd(10)} ${String(outcome.ms).padStart(6)}ms tokens=${outcome.tokens ?? "-"}${outcome.error ? `\n      ${outcome.error}` : ""}`;
    console.log(line);
  }
}
console.log(`\nPASS = schema valid and expected decision; PASS* = schema valid, different decision; ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
