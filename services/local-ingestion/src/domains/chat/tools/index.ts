import { tool } from "ai";
import { z } from "zod";
import type { CreateChatTools } from "../contracts.js";

/**
 * Temporary stub so the chat service and route tests run before the real tools land;
 * replaced wholesale by the tools implementation (C2).
 */
export const createChatTools: CreateChatTools = (_deps, req) => ({
  query_timeline: tool({
    description: "查询学习时间线",
    inputSchema: z.object({ from: z.string(), to: z.string() }),
    execute: async ({ from }) => ({
      days: [{ ref: req.registry.register({ kind: "day", id: from, title: `${from} 学习记录` }), day: from, totalSeconds: 600 }]
    })
  }),
  search_knowledge: tool({
    description: "检索知识库",
    inputSchema: z.object({ query: z.string(), k: z.number().int().max(8).optional() }),
    execute: async ({ query }) =>
      /k8s|kubernetes/i.test(query)
        ? { entries: [], items: [] }
        : { entries: [{ ref: req.registry.register({ kind: "entry", id: "stub-entry", title: "RAG" }), name: "RAG", summary: "检索增强生成" }], items: [] }
  }),
  get_entry: tool({
    description: "读取词条",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => ({ ref: req.registry.register({ kind: "entry", id, title: "词条" }), id, markdown: "" })
  }),
  get_item: tool({
    description: "读取条目",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => ({ ref: req.registry.register({ kind: "item", id, title: "条目" }), id, markdown: "" })
  }),
  list_mastery: tool({
    description: "列出掌握度",
    inputSchema: z.object({ level: z.enum(["weak", "familiar"]) }),
    execute: async () => ({ entries: [{ ref: req.registry.register({ kind: "entry", id: "stub-weak", title: "向量检索" }), name: "向量检索", mastery: 0.2 }] })
  }),
  propose_organize: tool({
    description: "生成整理确认卡片",
    inputSchema: z.object({ target: z.enum(["current", "pending", "all", "selected", "ask"]), requirement: z.string().optional() }),
    execute: async ({ requirement }) => {
      req.emit({ type: "organize-card", data: { options: [{ scope: "inbox_pending", label: "待整理", itemIds: [], entryIds: [] }], requirement } });
      return { proposed: true };
    }
  }),
  record_learner_profile: tool({
    description: "记录学习者档案",
    inputSchema: z.object({ role: z.string().optional(), direction: z.string().optional() }),
    execute: async ({ role, direction }) => {
      req.emit({ type: "profile-card", data: { role, direction, previous: { role: "", directions: [] } } });
      return { recorded: true };
    }
  })
});
