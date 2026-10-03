import type { ModelMessage, ToolSet, UIMessageStreamWriter } from "ai";
import type { ChatContext } from "@study-studio/shared";
import type { AiGateway } from "../../ai/gateway.js";
import type { ChatToolName } from "./contracts.js";
import { addDays, isDay, localDay, parseDay } from "../timeline/time.js";

/** Models that rejected tools (process lifetime); later requests go straight to the no-tools path. */
const toolsUnsupportedModels = new Set<string>();

export function chatModelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

export function markToolsUnsupported(key: string): void {
  toolsUnsupportedModels.add(key);
}

export function isToolsUnsupported(key: string): boolean {
  return toolsUnsupportedModels.has(key);
}

export function resetToolsSupportCache(): void {
  toolsUnsupportedModels.clear();
}

export type FallbackToolCall = { tool: ChatToolName; input: Record<string, unknown> };

const CN_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseCount(raw: string): number {
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return CN_DIGITS[raw] ?? 7;
}

function weekStart(day: string): string {
  const weekday = parseDay(day).getDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** Time words → inclusive local-day range; null when the text names no time. */
export function detectTimeRange(text: string, today: string): { from: string; to: string } | null {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (iso && isDay(iso)) return { from: iso, to: iso };
  const md = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (md) {
    const day = `${today.slice(0, 4)}-${md[1]!.padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
    if (isDay(day)) return { from: day, to: day };
  }
  const recent = /最近\s*(\d+|[一两二三四五六七八九十])\s*(天|周|个月)/.exec(text);
  if (recent) {
    const count = parseCount(recent[1]!);
    const days = recent[2] === "天" ? count : recent[2] === "周" ? count * 7 : count * 30;
    return { from: addDays(today, -(days - 1)), to: today };
  }
  if (/今天|今日/.test(text)) return { from: today, to: today };
  if (/前天/.test(text)) return { from: addDays(today, -2), to: addDays(today, -2) };
  if (/昨天|昨日/.test(text)) return { from: addDays(today, -1), to: addDays(today, -1) };
  if (/上周|上星期/.test(text)) {
    const start = addDays(weekStart(today), -7);
    return { from: start, to: addDays(start, 6) };
  }
  if (/本周|这周|这星期|本星期/.test(text)) return { from: weekStart(today), to: today };
  if (/本月|这个月/.test(text)) return { from: `${today.slice(0, 8)}01`, to: today };
  if (/最近|这几天/.test(text)) return { from: addDays(today, -6), to: today };
  return null;
}

function organizeTarget(text: string): string {
  if (/已选|选中|勾选/.test(text)) return "selected";
  if (/该页|本页|当前|这篇|这个|此页/.test(text)) return "current";
  if (/全量|全部|所有/.test(text)) return "all";
  if (/待整理|未整理/.test(text)) return "pending";
  return "ask";
}

function trimClause(text: string): string {
  return text
    .split(/[，。,.!！?？；;]/)[0]!
    .replace(/(相关的?)?(知识|内容|东西)$/u, "")
    .trim();
}

/**
 * Short imperative organize requests skip the model even when it supports tools: models
 * sometimes answer 「已展示卡片」 without calling propose_organize.
 */
export function isOrganizeCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 30 && /整理(?![了过])/.test(trimmed) && !/[?？]|什么|吗|怎么|如何/.test(trimmed);
}

/** 「我是产品经理」「我最近在学 AI」: saved directly; models tend to reply 「已记录」 without calling the tool. */
export function isProfileStatement(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 40 && /^(我是|我最近在学|我最近在研究|最近在学)/.test(trimmed) && !/[?？]|什么|吗|谁|哪/.test(trimmed);
}

/** Intents answered without the model (tool call + fixed reply). */
export function isDirectIntent(text: string): boolean {
  return isOrganizeCommand(text) || isProfileStatement(text);
}

/** Rule-based intent for models without tools (09「不支持 tools 的降级」). */
export function detectFallbackCalls(text: string, context: ChatContext, today: string): FallbackToolCall[] {
  if (/整理/.test(text)) return [{ tool: "propose_organize", input: { target: organizeTarget(text) } }];

  const direction = /(?:我最近在学|我最近在研究|最近在学)(.+)/.exec(text)?.[1];
  const role = /我是(.+)/.exec(text)?.[1];
  if (direction || role) {
    const input: Record<string, unknown> = {};
    if (direction) input.direction = trimClause(direction);
    else if (role) input.role = trimClause(role);
    return [{ tool: "record_learner_profile", input }];
  }

  const range = detectTimeRange(text, today);
  if (range) return [{ tool: "query_timeline", input: range }];

  if (/掌握|薄弱|不熟|弱项/.test(text)) {
    return [{ tool: "list_mastery", input: { level: /熟悉|掌握得?(好|不错)/.test(text) && !/不好|薄弱|不熟/.test(text) ? "familiar" : "weak" } }];
  }

  const calls: FallbackToolCall[] = [{ tool: "search_knowledge", input: { query: text, k: 6 } }];
  if (context.page === "entry" && context.entryId) calls.push({ tool: "get_entry", input: { id: context.entryId } });
  if (context.page === "item" && context.itemId) calls.push({ tool: "get_item", input: { id: context.itemId } });
  return calls;
}

type ExecutableTool = { execute?: (input: unknown, options: { toolCallId: string; messages: ModelMessage[]; context: unknown }) => unknown };

async function runTool(tools: ToolSet, call: FallbackToolCall, index: number): Promise<unknown> {
  const target = tools[call.tool] as ExecutableTool | undefined;
  if (!target?.execute) return { error: `tool ${call.tool} unavailable` };
  try {
    const output = await target.execute(call.input, { toolCallId: `fallback_${index}`, messages: [], context: {} });
    if (output && typeof output === "object" && Symbol.asyncIterator in output) {
      let last: unknown;
      for await (const chunk of output as AsyncIterable<unknown>) last = chunk;
      return last;
    }
    return output;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type FallbackParams = {
  writer: UIMessageStreamWriter;
  tools: ToolSet;
  userText: string;
  context: ChatContext;
  gateway: AiGateway;
  system: string;
  messages: ModelMessage[];
  allowOverLimit?: boolean;
  abortSignal?: AbortSignal;
  now: Date;
  /** Forwards one model stream into `writer`, returning the streamed text. */
  pump: (result: Awaited<ReturnType<AiGateway["streamChat"]>>["result"]) => Promise<string>;
};

export const ORGANIZE_CARD_TEXT = "请在下方卡片中确认整理范围。";
export const PROFILE_SAVED_TEXT = "好的，已记录。";

const READ_ONLY_TOOLS = new Set<ChatToolName>(["query_timeline", "search_knowledge", "get_entry", "get_item", "list_mastery"]);

/**
 * Rule-based read-only retrieval run before every model call, so answers stay grounded (and
 * citable) even when the model skips tool calls — small local models often do after the first turn.
 */
export async function preRetrieve(tools: ToolSet, text: string, context: ChatContext, now: Date): Promise<string> {
  const calls = detectFallbackCalls(text, context, localDay(now)).filter((call) => READ_ONLY_TOOLS.has(call.tool));
  if (calls.length === 0) return "";
  const outputs: string[] = [];
  for (const [index, call] of calls.entries()) {
    outputs.push(`### ${call.tool} ${JSON.stringify(call.input)}\n${JSON.stringify(await runTool(tools, call, index))}`);
  }
  return outputs.join("\n\n");
}

export async function runFallback(params: FallbackParams): Promise<{ text: string; model: string | null }> {
  const calls = detectFallbackCalls(params.userText, params.context, localDay(params.now));
  const outputs: { call: FallbackToolCall; output: unknown }[] = [];
  for (const [index, call] of calls.entries()) outputs.push({ call, output: await runTool(params.tools, call, index) });

  const direct = calls[0]?.tool === "propose_organize" ? ORGANIZE_CARD_TEXT : calls[0]?.tool === "record_learner_profile" ? PROFILE_SAVED_TEXT : null;
  if (direct) {
    const id = "fallback-text";
    params.writer.write({ type: "text-start", id });
    params.writer.write({ type: "text-delta", id, delta: direct });
    params.writer.write({ type: "text-end", id });
    return { text: direct, model: null };
  }

  const evidence = outputs.map(({ call, output }) => `### ${call.tool} ${JSON.stringify(call.input)}\n${JSON.stringify(output)}`).join("\n\n");
  const system = `${params.system}\n\n## 已检索资料\n当前模型不支持工具调用，以下是系统按问题自动调用工具得到的结果，按回答规则引用其中的 ref。\n\n${evidence}`;
  const chat = await params.gateway.streamChat({
    system,
    messages: params.messages,
    allowOverLimit: params.allowOverLimit,
    abortSignal: params.abortSignal
  });
  const text = await params.pump(chat.result);
  return { text, model: chatModelKey(chat.providerId, chat.model) };
}
