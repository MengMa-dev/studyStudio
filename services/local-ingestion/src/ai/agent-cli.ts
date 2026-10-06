import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError, type LanguageModel } from "ai";

/**
 * Agent CLIs (Cursor / Claude Code / Codex) driven headless as a plain text model: our prompts carry every stage's rules,
 * structured output is prompt-enforced JSON, and tools use a JSON tool-call protocol parsed here.
 * ponytail: one CLI process per call, no streaming (seconds of startup each); fine for opt-in agent providers.
 */

export const AGENT_CLIENTS = ["cursor", "claude", "codex"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

const TIMEOUT_MS = 10 * 60 * 1000;

/** launchd / systemd start the server with a minimal PATH; agent CLIs usually live in these dirs. */
export function agentEnv(): NodeJS.ProcessEnv {
  const extra = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".npm-global", "bin")];
  return { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(delimiter) };
}

let workdir: string | null = null;
/** CLIs run in an empty directory so they have no project to read or edit. */
function agentWorkdir(): string {
  workdir ??= join(tmpdir(), "study-studio-agent");
  mkdirSync(workdir, { recursive: true });
  return workdir;
}

const NO_TOOLS = "你被程序当作纯文本模型调用：不要读写文件、不要执行命令、不要调用任何你自带的工具，只根据以下内容作答。";

function stripFence(text: string): string {
  const match = /^```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i.exec(text.trim());
  return (match ? match[1]! : text).trim();
}

export function renderPrompt(options: Pick<LanguageModelV4CallOptions, "prompt" | "responseFormat" | "tools">): string {
  const parts = [NO_TOOLS];
  for (const message of options.prompt) {
    if (message.role === "system") parts.push(`## 系统指令\n${message.content}`);
    else if (message.role === "user") parts.push(`## 用户\n${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`);
    else if (message.role === "assistant") {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : part.type === "tool-call" ? `[调用工具 ${part.toolName} ${JSON.stringify(part.input)}]` : ""))
        .join("");
      parts.push(`## 助手\n${text}`);
    } else {
      for (const part of message.content) {
        if (part.type === "tool-result") parts.push(`## 工具结果（${part.toolName}）\n${JSON.stringify(part.output)}`);
      }
    }
  }
  const tools = (options.tools ?? []).filter((tool) => tool.type === "function");
  if (tools.length > 0) {
    const specs = tools.map((tool) => `- ${tool.name}：${tool.description ?? ""}\n  参数 JSON Schema：${JSON.stringify(tool.inputSchema)}`).join("\n");
    parts.push(
      `## 可用工具\n${specs}\n需要调用工具时，只输出一个 JSON 对象，不要其他文字：{"tool_calls":[{"name":"工具名","input":{参数}}]}。拿到工具结果后再给出最终回答；不需要工具时直接输出最终回答。`
    );
  }
  if (options.responseFormat?.type === "json") {
    const schema = options.responseFormat.schema ? `，并符合以下 JSON Schema：\n${JSON.stringify(options.responseFormat.schema)}` : "";
    parts.push(`## 输出要求\n只输出一个 JSON 值，不要代码块、不要解释${schema}`);
  }
  return parts.join("\n\n");
}

export function parseToolCalls(text: string): { name: string; input: unknown }[] | null {
  const body = stripFence(text);
  if (!body.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(body) as { tool_calls?: unknown };
    if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) return null;
    const calls = parsed.tool_calls as { name?: unknown; input?: unknown }[];
    return calls.every((call) => typeof call.name === "string") ? calls.map((call) => ({ name: call.name as string, input: call.input ?? {} })) : null;
  } catch {
    return null;
  }
}

type CliRun = { cmd: string; args: string[]; stdin?: string; outFile?: string };

export function cliCommand(client: AgentClient, model: string | null, prompt: string, cwd: string): CliRun {
  const modelArgs = (flag: string) => (model ? [flag, model] : []);
  if (client === "cursor") {
    return { cmd: "cursor-agent", args: ["-p", "--output-format", "json", "--mode", "ask", "--trust", "--workspace", cwd, ...modelArgs("--model"), prompt] };
  }
  if (client === "claude") {
    return {
      cmd: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--disallowedTools",
        "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch",
        ...modelArgs("--model")
      ],
      stdin: prompt
    };
  }
  const outFile = join(mkdtempSync(join(tmpdir(), "ss-codex-")), "last.txt");
  return {
    cmd: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-last-message", outFile, ...modelArgs("-m"), "-"],
    stdin: prompt,
    outFile
  };
}

type CliOutput = { text: string; inputTokens?: number; outputTokens?: number };

/** Cursor / Claude print `{ type: "result", is_error, result, usage? }`; Codex writes the last message to a file. */
export function parseCliOutput(client: AgentClient, stdout: string, outFileText: string | null): CliOutput {
  if (client === "codex") return { text: (outFileText ?? stdout).trim() };
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error(stdout.trim().slice(-500) || "agent 没有输出");
  const parsed = JSON.parse(line) as { is_error?: boolean; result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  if (parsed.is_error || typeof parsed.result !== "string") throw new Error(parsed.result || "agent 返回错误");
  return { text: parsed.result, inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens };
}

function cliError(client: AgentClient, message: string): APICallError {
  const hint = /auth|login|log in|credential|api key/i.test(message)
    ? `（请先在终端登录：${client === "cursor" ? "agent login" : client === "claude" ? "claude" : "codex login"}）`
    : "";
  return new APICallError({ message: `${client} agent: ${message}${hint}`, url: `agent://${client}`, requestBodyValues: {}, isRetryable: false });
}

export async function runAgentCli(client: AgentClient, model: string | null, prompt: string, abortSignal?: AbortSignal): Promise<CliOutput> {
  const run = cliCommand(client, model, prompt, agentWorkdir());
  try {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
      const child = spawn(run.cmd, run.args, { cwd: agentWorkdir(), env: agentEnv(), signal, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? cliError(client, `未找到命令 ${run.cmd}，请先安装并登录`) : error));
      child.on("close", (code) => resolve({ stdout, stderr, code }));
      child.stdin.end(run.stdin ?? "");
    });
    if (code !== 0) throw cliError(client, (stderr || stdout).trim().slice(-500) || `退出码 ${code}`);
    try {
      return parseCliOutput(client, stdout, run.outFile ? readFileSync(run.outFile, "utf8") : null);
    } catch (error) {
      throw cliError(client, error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (run.outFile) rmSync(join(run.outFile, ".."), { recursive: true, force: true });
  }
}

function usage(prompt: string, output: CliOutput) {
  return {
    inputTokens: { total: output.inputTokens ?? Math.ceil(prompt.length / 4), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output.outputTokens ?? Math.ceil(output.text.length / 4), text: undefined, reasoning: undefined }
  };
}

let toolCallSeq = 0;

function toContent(options: LanguageModelV4CallOptions, text: string): { content: LanguageModelV4Content[]; toolCalls: boolean } {
  const calls = options.tools?.length ? parseToolCalls(text) : null;
  if (calls) {
    return {
      content: calls.map((call) => ({
        type: "tool-call" as const,
        toolCallId: `agent-${++toolCallSeq}`,
        toolName: call.name,
        input: JSON.stringify(call.input)
      })),
      toolCalls: true
    };
  }
  return { content: [{ type: "text", text: options.responseFormat?.type === "json" ? stripFence(text) : text }], toolCalls: false };
}

/** `model` "default" (or empty) lets the CLI use its own configured model. */
export function createAgentLanguageModel(client: AgentClient, modelId: string): LanguageModel {
  const model = modelId && modelId !== "default" ? modelId : null;
  const call = async (options: LanguageModelV4CallOptions) => {
    const prompt = renderPrompt(options);
    const output = await runAgentCli(client, model, prompt, options.abortSignal);
    const { content, toolCalls } = toContent(options, output.text);
    const finishReason = toolCalls ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" };
    return { content, finishReason, usage: usage(prompt, output) };
  };
  const languageModel: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: `agent-${client}`,
    modelId: modelId || "default",
    supportedUrls: {},
    async doGenerate(options) {
      return { ...(await call(options)), warnings: [] };
    },
    async doStream(options) {
      const { content, finishReason, usage } = await call(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const part of content) {
        if (part.type === "text")
          parts.push({ type: "text-start", id: "t0" }, { type: "text-delta", id: "t0", delta: part.text }, { type: "text-end", id: "t0" });
        else if (part.type === "tool-call") parts.push(part);
      }
      parts.push({ type: "finish", usage, finishReason });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      };
    }
  };
  return languageModel;
}
