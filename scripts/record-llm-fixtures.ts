/**
 * Records real LLM responses for ③ learning judge and ⑤ extract / align as replay fixtures.
 * Output: services/local-ingestion/test/fixtures/llm/<task>/<name>.json
 *   { task, promptVersion, inputHash: sha256(JSON.stringify(input)), provider, model, input, output, usage, recordedAt }
 * Results (including failures) are merged into services/local-ingestion/test/fixtures/llm/recording-log.json.
 *
 * Usage: tsx scripts/record-llm-fixtures.ts [--only=learning_judge,knowledge_extract,knowledge_align] [--sample=name,...] [--fallback | --model=provider:model] [--force]
 *   --fallback  use the task's fallback model from ai-seed.json instead of the primary
 *   --model     use any provider from ai-seed.json, e.g. --model=gemini:gemini-3.5-flash-lite
 *   --force     re-record samples whose fixture already exists for the current prompt version (default: skip, to save quota)
 * Reads ai-seed.json and secrets.json from STUDY_STUDIO_DATA_DIR (default ./StudyStudioData).
 * Free-tier quota guard: at most CALL_BUDGET calls per model per run; structured output failure retries once in JSON mode.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { format, resolveConfig } from "prettier";
import { z } from "zod";
import { PROMPTS, type PromptTask } from "../services/local-ingestion/src/ai/prompts/index";
import { knowledgeAlignSamples, knowledgeExtractSamples, learningJudgeSamples, type Sample } from "../services/local-ingestion/test/fixtures/llm/samples";

const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");
const fixturesDir = join(root, "services/local-ingestion/test/fixtures/llm");
const arg = (name: string) =>
  process.argv
    .find((item) => item.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",");
const onlyTasks = arg("only");
const onlySamples = arg("sample");
const useFallback = process.argv.includes("--fallback");
const force = process.argv.includes("--force");
const modelOverride = arg("model")?.join(",");

/** Max calls per model in one run (free tiers: gemini-3.8-flash ~20 RPD, OpenRouter :free 50 RPD shared). */
const CALL_BUDGET: Record<string, number> = { "gemini-3.8-flash": 8, openrouter: 5 };
/** Minimum spacing between calls to stay under RPM limits. */
const MIN_INTERVAL_MS: Record<string, number> = { "gemini-3.8-flash": 13_000, "gemini-3.5-flash-lite": 4_500, groq: 2_000, openrouter: 3_500 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySample = Sample<any, any>;
const SAMPLES: Partial<Record<PromptTask, AnySample[]>> = {
  learning_judge: learningJudgeSamples,
  knowledge_extract: knowledgeExtractSamples,
  knowledge_align: knowledgeAlignSamples
};

type Seed = {
  providers: { id: string; type: string; base_url: string }[];
  task_models: { task: string; provider_id: string; model: string; fallback_provider_id: string | null; fallback_model: string | null }[];
};
type Mode = "structured" | "json";
type Target = { providerId: string; type: string; modelId: string; model: (mode: Mode) => LanguageModel };

const seed = JSON.parse(await readFile(join(dataDir, "ai-seed.json"), "utf8")) as Seed;
const secrets = JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8").catch(() => "{}")) as { providers?: Record<string, { apiKey: string }> };

function targetFor(name: PromptTask): Target {
  const task = PROMPTS[name].task;
  const row = seed.task_models.find((item) => item.task === task);
  if (!row) throw new Error(`task ${task} missing in ai-seed.json`);
  const [overrideProvider, ...overrideModel] = modelOverride?.split(":") ?? [];
  const providerId = overrideProvider ?? (useFallback ? row.fallback_provider_id : row.provider_id);
  const modelId = overrideModel.length ? overrideModel.join(":") : useFallback ? row.fallback_model : row.model;
  if (!providerId || !modelId) throw new Error(`task ${task} has no ${useFallback ? "fallback" : "primary"} model`);
  const provider = seed.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(`provider ${providerId} missing in ai-seed.json`);
  const apiKey = secrets.providers?.[providerId]?.apiKey;
  const base = { providerId, type: provider.type, modelId };
  if (provider.type === "ollama") return { ...base, model: () => createOllama({ baseURL: provider.base_url })(modelId) };
  if (provider.type === "google") return { ...base, model: () => createGoogleGenerativeAI({ apiKey, baseURL: provider.base_url })(modelId) };
  return {
    ...base,
    model: (mode) => createOpenAICompatible({ name: providerId, baseURL: provider.base_url, apiKey, supportsStructuredOutputs: mode === "structured" })(modelId)
  };
}

const budgetKey = (target: Target) => (target.providerId === "openrouter" ? "openrouter" : target.modelId);
const intervalKey = (target: Target) => (target.type === "openai-compatible" ? target.providerId : target.modelId);
const callsUsed = new Map<string, number>();
const lastCallAt = new Map<string, number>();

async function reserveCall(target: Target): Promise<boolean> {
  const key = budgetKey(target);
  const used = callsUsed.get(key) ?? 0;
  if (used >= (CALL_BUDGET[key] ?? Infinity)) return false;
  callsUsed.set(key, used + 1);
  const wait = (lastCallAt.get(intervalKey(target)) ?? 0) + (MIN_INTERVAL_MS[intervalKey(target)] ?? 0) - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(intervalKey(target), Date.now());
  return true;
}

type Usage = { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined; durationMs: number };
/** `retryable`: worth retrying in JSON mode (schema / parse errors); rate limits and 5xx are not, to save quota. */
type Attempt = { ok: true; output: unknown; usage: Usage } | { ok: false; error: string; durationMs: number; retryable: boolean };

async function attempt(task: PromptTask, target: Target, input: unknown, mode: Mode): Promise<Attempt> {
  const prompt = PROMPTS[task];
  const schema: z.ZodType = (prompt.outputSchema as (input: unknown) => z.ZodType)(input);
  /** OpenAI-style strict JSON Schema requires an object at the top level. */
  const wrap = target.type === "openai-compatible";
  const finalSchema: z.ZodType = wrap ? z.object({ result: schema }) : schema;
  const schemaHint = mode === "json" ? `\n\n输出必须符合以下 JSON Schema：\n${JSON.stringify(z.toJSONSchema(finalSchema))}` : "";
  const started = Date.now();
  try {
    const result = await generateObject({
      model: target.model(mode),
      schema: finalSchema,
      system: prompt.system + (wrap ? "\n结果放在 result 字段中。" : "") + schemaHint,
      prompt: (prompt.buildUserPrompt as (input: unknown) => string)(input),
      maxRetries: 0,
      ...(target.type === "ollama" ? { temperature: 0, providerOptions: { ollama: { options: { num_ctx: 8192 } } } } : {}),
      abortSignal: AbortSignal.timeout(target.type === "ollama" ? 300_000 : 180_000)
    });
    const output = wrap ? (result.object as { result: unknown }).result : result.object;
    const { inputTokens, outputTokens, totalTokens } = result.usage;
    return { ok: true, output, usage: { inputTokens, outputTokens, totalTokens, durationMs: Date.now() - started } };
  } catch (error) {
    const { message, statusCode, responseBody } = error as Error & { statusCode?: number; responseBody?: string };
    const detail = [statusCode, message, responseBody].filter(Boolean).join(" ").replace(/\s+/g, " ");
    const retryable = statusCode === undefined || (statusCode !== 429 && statusCode < 500);
    return { ok: false, error: detail.slice(0, 600), durationMs: Date.now() - started, retryable };
  }
}

const prettierConfig = (await resolveConfig(join(fixturesDir, "x.json"))) ?? {};
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await format(JSON.stringify(value), { ...prettierConfig, parser: "json" }));
}

type LogEntry = {
  task: PromptTask;
  sample: string;
  expected: string;
  promptVersion: string;
  provider: string;
  model: string;
  mode: Mode | null;
  status: "recorded" | "failed" | "skipped_budget";
  problems: string[];
  error: string | null;
  usage: Usage | null;
  recordedAt: string;
};
const logPath = join(fixturesDir, "recording-log.json");
const log = JSON.parse(await readFile(logPath, "utf8").catch(() => "[]")) as LogEntry[];
const upsertLog = (entry: LogEntry) => {
  const index = log.findIndex((item) => item.task === entry.task && item.sample === entry.sample && item.model === entry.model);
  if (index >= 0) log[index] = entry;
  else log.push(entry);
};

const tasks = (Object.keys(SAMPLES) as PromptTask[]).filter((task) => !onlyTasks || onlyTasks.includes(task));
let failures = 0;
for (const task of tasks) {
  const target = targetFor(task);
  const promptVersion = PROMPTS[task].version;
  for (const sample of (SAMPLES[task] ?? []).filter((item) => !onlySamples || onlySamples.includes(item.name))) {
    const fixturePath = join(fixturesDir, task, `${sample.name}.json`);
    const inputHash = createHash("sha256").update(JSON.stringify(sample.input)).digest("hex");
    const existing = JSON.parse(await readFile(fixturePath, "utf8").catch(() => "null")) as { promptVersion: string; inputHash: string } | null;
    if (!force && existing?.promptVersion === promptVersion && existing.inputHash === inputHash) {
      console.log(`SKIP  ${task}/${sample.name} (fixture up to date)`);
      continue;
    }
    const entry: LogEntry = {
      task,
      sample: sample.name,
      expected: sample.expected,
      promptVersion,
      provider: target.providerId,
      model: target.modelId,
      mode: null,
      status: "skipped_budget",
      problems: [],
      error: null,
      usage: null,
      recordedAt: new Date().toISOString()
    };
    let result: Attempt | null = null;
    const errors: string[] = [];
    for (const mode of ["structured", "json"] as const) {
      if (!(await reserveCall(target))) break;
      entry.mode = mode;
      result = await attempt(task, target, sample.input, mode);
      if (result.ok) break;
      errors.push(`${mode}: ${result.error}`);
      if (!result.retryable) break;
    }
    if (result?.ok) {
      entry.status = "recorded";
      entry.usage = result.usage;
      entry.problems = sample.check(result.output);
      await writeJson(fixturePath, {
        task,
        promptVersion,
        inputHash,
        provider: target.providerId,
        model: target.modelId,
        input: sample.input,
        output: result.output,
        usage: result.usage,
        recordedAt: entry.recordedAt
      });
    } else if (result) {
      entry.status = "failed";
      failures += 1;
    }
    entry.error = errors.length ? errors.join(" | ") : null;
    upsertLog(entry);
    await writeJson(logPath, log);
    const verdict = entry.status === "recorded" ? (entry.problems.length ? "DIFF" : "PASS") : entry.status === "failed" ? "FAIL" : "BUDGET";
    const usage = entry.usage ? `${entry.usage.durationMs}ms tokens=${entry.usage.inputTokens}/${entry.usage.outputTokens}` : "";
    console.log(
      `${verdict.padEnd(6)} ${`${task}/${sample.name}`.padEnd(44)} ${`${target.providerId}/${target.modelId}`.padEnd(32)} mode=${entry.mode ?? "-"} ${usage}`
    );
    for (const line of [...entry.problems, ...errors]) console.log(`       ${line}`);
  }
}
console.log(
  `\nPASS = matches expected branch; DIFF = recorded, differs from expectation; ${failures} failure(s). Calls: ${JSON.stringify(Object.fromEntries(callsUsed))}`
);
process.exit(failures ? 1 : 0);
