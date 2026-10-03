import type { ChatTransport, UIMessageChunk } from "ai";
import {
  type ChatCitation,
  type ChatContext,
  type ChatOrganizeCardData,
  type ChatOrganizeOption,
  type ChatProfileCardData,
  type LearnerProfile
} from "@study-studio/shared";
import { messageText, type StudyChatDataTypes, type StudyChatMessage } from "@/lib/chat";
import type { ChatTransportOptions } from "../real/chat";

import { mockChatModelConfigured } from "./ai";
import { getMockState } from "./client";
import { mockKbEntryBriefs, mockKbEntryName } from "./kb";

type Segment =
  | { kind: "tool"; name: string; input: unknown; output: unknown }
  | { kind: "text"; text: string }
  | { [K in keyof StudyChatDataTypes]: { kind: "data"; name: K; data: StudyChatDataTypes[K] } }[keyof StudyChatDataTypes];

let messages: StudyChatMessage[] = [];
let charDelayMs = 12;
let overLimit = false;
let sequence = 0;

export function resetMockChatState(): void {
  messages = [];
  overLimit = false;
  sequence = 0;
}

/** Per-chunk delay of the mock stream; tests set 0. */
export function setMockChatDelay(ms: number): void {
  charDelayMs = ms;
}

/** Simulates the daily token limit: sends fail with 429 unless `allowOverLimit`. */
export function setMockChatOverLimit(value: boolean): void {
  overLimit = value;
}

export function getMockChatMessages(): StudyChatMessage[] {
  return messages;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pct(value: number | null): string {
  return value === null ? "未评估" : `${Math.round(value * 100)}%`;
}

function citations(list: ChatCitation[], nonRecord = false): Segment {
  return { kind: "data", name: "citations", data: { citations: list, nonRecord } };
}

function itemTitle(id: string): string {
  return getMockState().items.find((item) => item.id === id)?.title ?? id;
}

// ---- intents ----

const QUESTION = /[？?吗呢]$|什么|哪些|怎么|多少/;

function organizeReply(text: string, ctx: ChatContext): Segment[] | null {
  if (!/整理/.test(text) || /没整理|未整理的有|哪些/.test(text)) return null;
  const current: ChatOrganizeOption | null =
    ctx.page === "item" && ctx.itemId
      ? { scope: "item", label: "当前条目", itemIds: [ctx.itemId], entryIds: [], targetName: itemTitle(ctx.itemId) }
      : ctx.page === "entry" && ctx.entryId
        ? { scope: "entry", label: "当前知识点", itemIds: [], entryIds: [ctx.entryId], targetName: mockKbEntryName(ctx.entryId) }
        : null;
  const selectedItems = ctx.page === "inbox" ? (ctx.selectedItemIds ?? []) : [];
  const selectedEntries = ctx.page === "wiki" ? (ctx.selectedEntryIds ?? []) : [];
  const selected: ChatOrganizeOption | null = selectedItems.length
    ? { scope: "inbox_selected", label: `已选（${selectedItems.length} 条）`, itemIds: selectedItems, entryIds: [] }
    : selectedEntries.length
      ? { scope: "kb_selected", label: `已选（${selectedEntries.length} 个知识点）`, itemIds: [], entryIds: selectedEntries }
      : null;

  const card = (options: ChatOrganizeOption[], requirement?: string): Segment => ({
    kind: "data",
    name: "organize-card",
    data: { options, ...(requirement ? { requirement } : {}) } satisfies ChatOrganizeCardData
  });
  const tool: Segment = { kind: "tool", name: "propose_organize", input: { target: current ? "current" : "ask" }, output: { ok: true } };

  if (current && /该页|这页|本页|当前|这篇|这个|这条/.test(text)) {
    const requirement =
      text.replace(/^(请|帮我|麻烦)?整理(一下)?(该页|这页|本页|当前|这篇|这个|这条)(页面|文章|内容)?(的)?(知识点)?[，,。]?/, "").trim() ||
      "提炼该页的核心知识点，补充与已有知识点的关联";
    const kind = current.scope === "item" ? "条目" : "知识点";
    return [tool, { kind: "text", text: `识别到当前页面是${kind}「${current.targetName}」，确认后开始整理：` }, card([current], requirement)];
  }
  if (selected && /已选/.test(text)) {
    return [tool, { kind: "text", text: `将整理你${selected.label}的内容，确认后开始：` }, card([selected])];
  }

  const kb = ctx.page === "wiki";
  const options: ChatOrganizeOption[] = [
    ...(current ? [current] : []),
    { scope: kb ? "kb_pending" : "inbox_pending", label: ctx.page === "entry" ? "所有未整理内容" : "待整理", itemIds: [], entryIds: [] },
    { scope: kb ? "kb_all" : "inbox_all", label: "全量", itemIds: [], entryIds: [] },
    ...(selected ? [selected] : [])
  ];
  return [tool, { kind: "text", text: "要整理哪些内容？选择范围后确认：" }, card(options)];
}

function normalizeTopic(raw: string): string {
  const topic = raw
    .replace(/[。！!，,；;~～]+$/, "")
    .replace(/(?:相关|方面|领域)?的?(?:知识|内容|东西|技术)$/, "")
    .replace(/(?:相关|方面|领域)$/, "")
    .trim();
  return /^[a-z0-9 .+-]{1,6}$/i.test(topic) ? topic.toUpperCase() : topic;
}

function profileReply(text: string): Segment[] | null {
  if (QUESTION.test(text)) return null;
  const role = text.match(/我是(?:一[名个位])?([^，,。！!；;\s]{2,12}?)(?:[，,。！!；;\s]|$)/)?.[1];
  const rawTopic = text.match(/(?:最近|近期|现在|正在|这段时间)(?:在|正在|开始)?(?:学习|学|研究)(?:一下|一些)?(.+)$/)?.[1];
  const direction = rawTopic ? normalizeTopic(rawTopic) : undefined;
  if (!role && !direction) return null;

  const state = getMockState();
  const previous: LearnerProfile = structuredClone(state.profile);
  const next: LearnerProfile = {
    role: role ?? previous.role,
    directions:
      direction && !previous.directions.some((entry) => entry.text.toLowerCase() === direction.toLowerCase())
        ? [...previous.directions, { id: nextId("dir"), text: direction, expiresAt: localDate(30) }]
        : previous.directions
  };
  state.profile = next;
  state.home.profile = next;

  const parts = [role ? `角色「${role}」` : "", direction ? `近期学习方向「${direction}」（30 天后到期）` : ""].filter(Boolean).join("；");
  const data: ChatProfileCardData = { ...(role ? { role } : {}), ...(direction ? { direction } : {}), previous };
  return [
    { kind: "tool", name: "record_learner_profile", input: { role, direction }, output: { ok: true } },
    { kind: "text", text: `好的，已记录${parts}。整理时和它相关的内容更容易被判定为学习并入库。` },
    { kind: "data", name: "profile-card", data }
  ];
}

function timelineReply(text: string): Segment[] | null {
  if (!/今天|今日|昨天|最近|一周|本周|这周/.test(text) || !/学/.test(text)) return null;
  const week = /最近|一周|本周|这周/.test(text);
  const day = localDate(0);
  const items = getMockState().items.slice(0, 3);
  const list: ChatCitation[] = [
    { n: 1, kind: "day", id: day, title: week ? "近 7 天学习记录" : `${day} 学习记录` },
    ...items.map((item, index) => ({ n: index + 2, kind: "item" as const, id: item.id, title: item.title }))
  ];
  const lines = items.map((item, index) => `- **${item.title}** [${index + 2}]`).join("\n");
  const body = week
    ? `最近 7 天你学习了 **8 小时 1 分**，连续学习 5 天 [1]，主线是检索与重排：\n\n${lines}\n\n建议：「HNSW」掌握度只有 20%，可以先补这块。`
    : `今天你学习了 **1 小时 42 分**，共 ${items.length} 条学习记录 [1]：\n\n${lines}\n\n主线是**重排模型选型**：先问了交叉编码器是什么，又读了双塔与交叉编码器的对比。建议接着读完 HNSW 那篇文章。`;
  return [
    { kind: "tool", name: "query_timeline", input: { from: week ? localDate(-6) : day, to: day }, output: { days: week ? 7 : 1 } },
    { kind: "text", text: body },
    citations(list)
  ];
}

function masteryReply(text: string): Segment[] | null {
  if (!/掌握|薄弱|不熟/.test(text)) return null;
  const entries = mockKbEntryBriefs().filter((entry) => entry.mastery !== null);
  const weak = entries.filter((entry) => (entry.mastery ?? 1) < 0.4).slice(0, 4);
  const strong = entries.filter((entry) => (entry.mastery ?? 0) >= 0.65).slice(0, 3);
  const list: ChatCitation[] = [...weak, ...strong].map((entry, index) => ({ n: index + 1, kind: "entry", id: entry.id, title: entry.name }));
  const ref = (id: string) => `[${list.find((item) => item.id === id)?.n}]`;
  const body = [
    `比较薄弱的 ${weak.length} 个：`,
    "",
    ...weak.map((entry) => `- ${entry.name}（${pct(entry.mastery)}）${ref(entry.id)}`),
    "",
    `掌握较好的：${strong.map((entry) => `${entry.name} ${ref(entry.id)}`).join("、")}。`,
    "",
    "建议从 **ANN → HNSW** 补起，它们是向量检索的基础。"
  ].join("\n");
  return [{ kind: "tool", name: "list_mastery", input: { level: "weak" }, output: { count: weak.length } }, { kind: "text", text: body }, citations(list)];
}

function pageReply(text: string, ctx: ChatContext): Segment[] | null {
  if (ctx.page === "item" && ctx.itemId && /这篇|这条|讲了什么|讲的是/.test(text)) {
    const title = itemTitle(ctx.itemId);
    return [
      { kind: "tool", name: "get_item", input: { id: ctx.itemId }, output: { title } },
      {
        kind: "text",
        text: `《${title}》主要讲了三点 [1]：\n\n1. 问题背景与动机\n2. 核心思路与关键参数\n3. 实践中的取舍\n\n其中第二点与你知识库里的已有知识点关联最紧密。`
      },
      citations([{ n: 1, kind: "item", id: ctx.itemId, title }])
    ];
  }
  if (ctx.page === "entry" && ctx.entryId && /完整|有关|相关|关系/.test(text)) {
    const name = mockKbEntryName(ctx.entryId);
    const related = mockKbEntryBriefs()
      .filter((entry) => entry.id !== ctx.entryId)
      .slice(0, 2);
    const list: ChatCitation[] = [
      { n: 1, kind: "entry", id: ctx.entryId, title: name },
      ...related.map((entry, index) => ({ n: index + 2, kind: "entry" as const, id: entry.id, title: entry.name }))
    ];
    const body = /完整/.test(text)
      ? `「${name}」目前覆盖了定义与核心原理 [1]，还缺少：\n\n- 具体应用示例\n- 常见误区与注意事项\n\n可以说「帮我整理该页知识点」让 AI 补全。`
      : `「${name}」[1] 与这些知识点关系最紧密：${related.map((entry, index) => `${entry.name} [${index + 2}]`).join("、")}。`;
    return [{ kind: "tool", name: "get_entry", input: { id: ctx.entryId }, output: { name } }, { kind: "text", text: body }, citations(list)];
  }
  return null;
}

function knowledgeReply(text: string): Segment[] | null {
  const lower = text.toLowerCase();
  const entries = mockKbEntryBriefs();
  const hits = /rag|检索增强/.test(lower)
    ? entries.filter((entry) => ["kb-hybrid", "kb-rerank", "kb-cross"].includes(entry.id))
    : entries.filter((entry) => lower.includes(entry.name.toLowerCase())).slice(0, 3);
  if (!hits.length) return null;
  const list: ChatCitation[] = hits.map((entry, index) => ({ n: index + 1, kind: "entry", id: entry.id, title: entry.name }));
  const head = /rag|检索增强/.test(lower)
    ? "**RAG（检索增强生成）** 是先检索相关资料、再交给大模型生成回答的方法。你学过的组成部分："
    : `关于 **${hits[0]?.name}**，你的学习记录里有这些：`;
  const body = [
    head,
    "",
    ...hits.map((entry, index) => `- **${entry.name}**：掌握 ${pct(entry.mastery)} [${index + 1}]`),
    "",
    "还没覆盖：文档切块策略、效果评估（召回率、忠实度）。建议先补掌握度最低的部分。"
  ].join("\n");
  return [
    { kind: "tool", name: "search_knowledge", input: { query: text, k: 5 }, output: { hits: hits.length } },
    { kind: "text", text: body },
    citations(list)
  ];
}

function fallbackReply(text: string): Segment[] {
  const topic = text.replace(/[？?。！!]+$/, "").replace(/^(什么是|请问|问一下)/, "");
  const general = /k8s|kubernetes/i.test(text)
    ? "Kubernetes（k8s）是开源的容器编排平台，负责容器化应用的部署、扩缩容与自愈。"
    : `「${topic}」不在你的学习记录中，以下是通用知识的简要说明，仅供参考。`;
  return [
    { kind: "tool", name: "search_knowledge", input: { query: text, k: 5 }, output: { hits: 0 } },
    { kind: "text", text: `以下内容非学习记录：知识库没有相关内容。\n\n${general}` },
    citations([], true)
  ];
}

export function buildMockReply(text: string, ctx: ChatContext): Segment[] {
  return (
    organizeReply(text, ctx) ??
    profileReply(text) ??
    pageReply(text, ctx) ??
    timelineReply(text) ??
    masteryReply(text) ??
    knowledgeReply(text) ??
    fallbackReply(text)
  );
}

// ---- stream ----

function toParts(segments: Segment[], toolIds: string[]): StudyChatMessage["parts"] {
  return segments.map((segment, index): StudyChatMessage["parts"][number] => {
    if (segment.kind === "text") return { type: "text", text: segment.text, state: "done" };
    if (segment.kind === "data") return { type: `data-${segment.name}`, data: segment.data } as StudyChatMessage["parts"][number];
    return {
      type: "dynamic-tool",
      toolName: segment.name,
      toolCallId: toolIds[index] ?? `call-${index}`,
      state: "output-available",
      input: segment.input,
      output: segment.output
    };
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function httpError(code: string, status: number): Error {
  return Object.assign(new Error(JSON.stringify({ error: code })), { statusCode: status });
}

function createMockChatTransport({ getContext }: ChatTransportOptions): ChatTransport<StudyChatMessage> {
  return {
    async sendMessages({ messages: sent, abortSignal, body }) {
      const userMessage = sent.findLast((message) => message.role === "user");
      if (!userMessage) throw new Error("no user message");
      if (!mockChatModelConfigured()) throw httpError("chat_model_not_configured", 409);
      const allowOverLimit = Boolean((body as { allowOverLimit?: boolean } | undefined)?.allowOverLimit);
      if (overLimit && !allowOverLimit) throw httpError("usage_limit_exceeded", 429);

      const context = getContext();
      const index = messages.findIndex((message) => message.id === userMessage.id);
      messages = [...(index >= 0 ? messages.slice(0, index) : messages), { ...userMessage, metadata: { context } }];

      const segments = buildMockReply(messageText(userMessage), context);
      const assistantId = nextId("msg");
      const toolIds = segments.map(() => nextId("call"));

      return new ReadableStream<UIMessageChunk>({
        async start(controller) {
          const emit = (chunk: UIMessageChunk) => controller.enqueue(chunk);
          emit({ type: "start", messageId: assistantId });
          emit({ type: "start-step" });
          for (const [position, segment] of segments.entries()) {
            if (abortSignal?.aborted) break;
            if (segment.kind === "tool") {
              const toolCallId = toolIds[position] ?? `call-${position}`;
              emit({ type: "tool-input-available", toolCallId, toolName: segment.name, input: segment.input, dynamic: true });
              await sleep(charDelayMs * 25, abortSignal);
              emit({ type: "tool-output-available", toolCallId, output: segment.output, dynamic: true });
            } else if (segment.kind === "text") {
              const id = `${assistantId}-text-${position}`;
              emit({ type: "text-start", id });
              const step = charDelayMs > 0 ? 2 : segment.text.length;
              for (let offset = 0; offset < segment.text.length && !abortSignal?.aborted; offset += step) {
                emit({ type: "text-delta", id, delta: segment.text.slice(offset, offset + step) });
                await sleep(charDelayMs, abortSignal);
              }
              emit({ type: "text-end", id });
            } else {
              emit({ type: `data-${segment.name}`, data: segment.data } as UIMessageChunk);
            }
          }
          if (!abortSignal?.aborted) {
            messages = [...messages, { id: assistantId, role: "assistant", parts: toParts(segments, toolIds) }];
            emit({ type: "finish-step" });
            emit({ type: "finish", finishReason: "stop" });
          }
          controller.close();
        }
      });
    },

    async reconnectToStream() {
      return null;
    }
  };
}

export const mockChatApi = {
  async getChatMessages() {
    return { messages: structuredClone(messages) };
  },

  async clearChat() {
    messages = [];
    return { ok: true as const };
  },

  createChatTransport: createMockChatTransport
};
