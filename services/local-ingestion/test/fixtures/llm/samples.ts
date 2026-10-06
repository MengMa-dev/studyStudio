/**
 * Sample inputs for recording LLM fixtures (`scripts/record-llm-fixtures.ts`).
 * Learner profile follows the dev convention: role 前端开发, learning focus Agent 架构.
 * `check` returns the mismatches between a recorded output and the expected branch (empty = as expected).
 */
import { SEED_KINDS } from "@study-studio/shared";
import type {
  KnowledgeAlignInput,
  KnowledgeAlignOutput,
  KnowledgeExtractInput,
  KnowledgeExtractOutput,
  LearningJudgeInput,
  LearningJudgeOutput
} from "../../../src/ai/prompts/schemas.draft";
import { normalizeEntryName } from "../../../src/domains/organize/normalize";
import { checkAlign, checkExtract, entrySections, sourceSections, type SourceText } from "../../../src/domains/organize/verify";

export type Sample<I, O> = { name: string; expected: string; input: I; check: (output: O) => string[] };

const JUDGE_PROFILE = { role: "前端开发", learning_focus: [{ topic: "Agent 架构", expires_at: "2026-11-01" }] };
const RECENT_TOPICS = ["LangGraph", "RAG 重排", "Function Calling"];
const CATEGORIES = ["Agent 框架", "RAG", "前端工程", "LLM 基础"];
const KINDS = [...SEED_KINDS];

function judgeCheck(expect: { learning: boolean; band: "high" | "uncertain" | "low"; action?: "keep" | "split"; candidates?: string[]; returned?: boolean }) {
  return (output: LearningJudgeOutput): string[] => {
    const problems: string[] = [];
    const band = output.confidence >= 0.7 ? "high" : output.confidence >= 0.4 ? "uncertain" : "low";
    const routedIn = output.is_learning && output.worth_extracting && output.confidence >= 0.4;
    if (expect.learning !== routedIn) problems.push(`进入 ④ 应为 ${expect.learning}，实际 ${routedIn}`);
    if (expect.learning && band !== expect.band) problems.push(`置信度档位应为 ${expect.band}，实际 ${band}(${output.confidence})`);
    if (expect.action && output.segment_suggestion.action !== expect.action)
      problems.push(`segment_suggestion 应为 ${expect.action}，实际 ${output.segment_suggestion.action}`);
    if (expect.returned !== undefined && output.returned_to_topic !== expect.returned) problems.push(`returned_to_topic 应为 ${expect.returned}`);
    for (const id of expect.candidates ?? []) if (!output.candidate_item_ids.includes(id)) problems.push(`缺少候选条目 ${id}`);
    return problems;
  };
}

// ③ Learning Judge

export const learningJudgeSamples: Sample<LearningJudgeInput, LearningJudgeOutput>[] = [
  {
    name: "learning",
    expected: "学习，高置信度；候选 A/B/C，B、C 为 strong",
    input: {
      episode_id: "ep_20261002_2000",
      time_range: { start: "2026-10-02T20:00:00+08:00", end: "2026-10-02T20:40:00+08:00" },
      active_minutes: 36,
      learner_profile: JUDGE_PROFILE,
      recent_kb_topics: RECENT_TOPICS,
      timeline: [
        { t: "20:00", kind: "search", query: "LangGraph checkpoint", engine: "google" },
        {
          t: "20:02",
          kind: "page",
          title: "Persistence - LangGraph Docs",
          domain: "langchain-ai.github.io",
          category: "learning_candidate",
          active_sec: 420,
          scroll: 0.8,
          captured_item_id: "item_A",
          from: "search"
        },
        {
          t: "20:10",
          kind: "ai_turn",
          platform: "chatgpt",
          conversation_id: "c1",
          question: "checkpoint 和 interrupt 有什么区别？",
          turn_index: 1,
          captured_item_id: "item_B"
        },
        { t: "20:13", kind: "ai_turn", platform: "chatgpt", conversation_id: "c1", question: "interrupt 恢复时状态从哪里读？", turn_index: 2 },
        {
          t: "20:18",
          kind: "page",
          title: "Human-in-the-loop - LangGraph Docs",
          domain: "langchain-ai.github.io",
          category: "learning_candidate",
          active_sec: 600,
          scroll: 0.9,
          captured_item_id: "item_C",
          revisit: false
        },
        { t: "20:26", kind: "selection", text: "interrupt() pauses graph execution...", captured_item_id: "item_C" },
        { t: "20:35", kind: "note", text: "HITL 依赖 checkpoint 持久化", captured_item_id: "item_C" }
      ],
      flags: []
    },
    check: judgeCheck({ learning: true, band: "high", action: "keep", candidates: ["item_A", "item_B", "item_C"] })
  },
  {
    name: "non-learning",
    expected: "非学习（查快递 + 购物），不进入 ④",
    input: {
      episode_id: "ep_20261002_1230",
      time_range: { start: "2026-10-02T12:30:00+08:00", end: "2026-10-02T12:52:00+08:00" },
      active_minutes: 18,
      learner_profile: JUDGE_PROFILE,
      recent_kb_topics: RECENT_TOPICS,
      timeline: [
        { t: "12:30", kind: "search", query: "顺丰 国庆 几点停止派送", engine: "baidu" },
        {
          t: "12:31",
          kind: "page",
          title: "顺丰速运国庆节期间服务安排公告",
          domain: "sf-express.com",
          category: "neutral",
          active_sec: 95,
          scroll: 0.5,
          captured_item_id: "item_sf",
          from: "search"
        },
        { t: "12:34", kind: "distraction", domain_category: "shopping", duration_sec: 720 },
        {
          t: "12:46",
          kind: "page",
          title: "机械键盘选购指南 2026",
          domain: "zhihu.com",
          category: "neutral",
          active_sec: 240,
          scroll: 0.6,
          captured_item_id: "item_kb"
        }
      ],
      flags: []
    },
    check: judgeCheck({ learning: false, band: "low" })
  },
  {
    name: "low-confidence",
    expected: "只有停留与滚动的弱信号：置信度 0.4–0.7（uncertain）",
    input: {
      episode_id: "ep_20261002_0915",
      time_range: { start: "2026-10-02T09:15:00+08:00", end: "2026-10-02T09:24:00+08:00" },
      active_minutes: 6,
      learner_profile: JUDGE_PROFILE,
      recent_kb_topics: RECENT_TOPICS,
      timeline: [
        {
          t: "09:15",
          kind: "page",
          title: "Understanding React Server Components",
          domain: "vercel.com",
          category: "learning_candidate",
          active_sec: 210,
          scroll: 0.45,
          captured_item_id: "item_rsc",
          from: "link"
        },
        { t: "09:20", kind: "page", title: "Vercel Changelog", domain: "vercel.com", category: "neutral", active_sec: 60, scroll: 0.2 }
      ],
      flags: []
    },
    check: judgeCheck({ learning: true, band: "uncertain", candidates: ["item_rsc"] })
  },
  {
    name: "distraction",
    expected: "学习；中途长分心后回到 MCP 主题：keep、returned_to_topic=true、记录 1 段分心",
    input: {
      episode_id: "ep_20261002_2130",
      time_range: { start: "2026-10-02T21:30:00+08:00", end: "2026-10-02T22:25:00+08:00" },
      active_minutes: 50,
      learner_profile: JUDGE_PROFILE,
      recent_kb_topics: RECENT_TOPICS,
      timeline: [
        { t: "21:30", kind: "search", query: "MCP model context protocol 是什么", engine: "google" },
        {
          t: "21:31",
          kind: "page",
          title: "Introduction - Model Context Protocol",
          domain: "modelcontextprotocol.io",
          category: "learning_candidate",
          active_sec: 540,
          scroll: 0.85,
          captured_item_id: "item_mcp_intro",
          from: "search"
        },
        {
          t: "21:41",
          kind: "ai_turn",
          platform: "deepseek",
          conversation_id: "c7",
          question: "MCP 和 function calling 是什么关系？",
          turn_index: 1,
          captured_item_id: "item_mcp_qa"
        },
        { t: "21:45", kind: "distraction", domain_category: "video", duration_sec: 1200 },
        {
          t: "22:05",
          kind: "page",
          title: "Architecture overview - Model Context Protocol",
          domain: "modelcontextprotocol.io",
          category: "learning_candidate",
          active_sec: 660,
          scroll: 0.9,
          captured_item_id: "item_mcp_arch"
        },
        { t: "22:18", kind: "copy", text: "Hosts are LLM applications that initiate connections", captured_item_id: "item_mcp_arch" },
        { t: "22:20", kind: "note", text: "host / client / server 三层，client 与 server 一对一", captured_item_id: "item_mcp_arch" }
      ],
      flags: ["long_distraction"]
    },
    check: judgeCheck({ learning: true, band: "high", action: "keep", returned: true, candidates: ["item_mcp_intro", "item_mcp_qa", "item_mcp_arch"] })
  },
  {
    name: "split",
    expected: "长分心后主题完全变化（LangGraph → CSS 容器查询）：split，at=19:40",
    input: {
      episode_id: "ep_20261002_1800",
      time_range: { start: "2026-10-02T18:00:00+08:00", end: "2026-10-02T19:55:00+08:00" },
      active_minutes: 62,
      learner_profile: JUDGE_PROFILE,
      recent_kb_topics: RECENT_TOPICS,
      timeline: [
        { t: "18:00", kind: "search", query: "LangGraph subgraph state", engine: "google" },
        {
          t: "18:01",
          kind: "page",
          title: "Subgraphs - LangGraph Docs",
          domain: "langchain-ai.github.io",
          category: "learning_candidate",
          active_sec: 900,
          scroll: 0.9,
          captured_item_id: "item_subgraph",
          from: "search"
        },
        {
          t: "18:18",
          kind: "ai_turn",
          platform: "chatgpt",
          conversation_id: "c9",
          question: "子图和父图的 state key 不一致怎么传递？",
          turn_index: 1,
          captured_item_id: "item_subgraph_qa"
        },
        { t: "18:25", kind: "distraction", domain_category: "video", duration_sec: 1500 },
        { t: "19:40", kind: "search", query: "css container queries vs media queries", engine: "google" },
        {
          t: "19:41",
          kind: "page",
          title: "CSS container queries - MDN",
          domain: "developer.mozilla.org",
          category: "learning_candidate",
          active_sec: 600,
          scroll: 0.8,
          captured_item_id: "item_container_queries",
          from: "search"
        },
        { t: "19:52", kind: "selection", text: "container-type: inline-size", captured_item_id: "item_container_queries" }
      ],
      flags: ["long_distraction"]
    },
    check: judgeCheck({ learning: true, band: "high", action: "split" })
  }
];

// ⑤ Knowledge Processing

const HITL_ENTRY = {
  entry_id: "kb_hitl",
  name: "Human-in-the-loop",
  aliases: ["HITL", "人在回路"],
  kind: "concept",
  summary: "在 Agent 执行过程中插入人工审批或输入节点，让人参与关键决策。",
  body_markdown:
    "## 定义\n在 Agent 执行过程中插入人工审批或输入节点，由人确认后再继续。\n## 实现方式\n在需要人工介入的节点暂停执行，等待用户输入后继续。\n## 常见场景\n- 工具调用前审批（如发邮件、付款）\n- 让用户修改 Agent 生成的计划"
};

const CHECKPOINT_ENTRY = {
  entry_id: "kb_checkpoint",
  name: "Checkpoint",
  aliases: ["检查点", "checkpointer"],
  kind: "concept",
  summary: "LangGraph 在每个 super-step 结束时保存图状态快照，用于记忆、容错与时间回溯。",
  body_markdown:
    "## 定义\nLangGraph 在每个 super-step 结束时把图状态保存为 checkpoint，按 thread_id 组织。\n## Checkpointer 实现\n- MemorySaver：内存，测试用\n- SqliteSaver / PostgresSaver：持久化，生产用\n## 用途\n- 对话记忆（同一 thread 继续）\n- 失败后从最近 checkpoint 恢复\n- 时间回溯（replay / fork）"
};

const AGENT_LOOP_ENTRY = {
  entry_id: "kb_agent_loop",
  name: "Agent Loop",
  aliases: ["智能体循环"],
  kind: "pattern",
  summary: "LLM 在循环中根据观察结果决定下一步动作（调用工具或结束），直到完成任务。",
  body_markdown:
    "## 定义\nLLM 在循环中根据上一步的观察结果决定下一步动作，直到完成任务或达到步数上限。\n## 基本流程\n1. 模型决定调用哪个工具\n2. 程序执行工具并把结果返回给模型\n3. 重复直到模型给出最终回答"
};

type SourceEntry = { entry_id: string; name: string; aliases: string[]; kind: string; summary: string; body_markdown: string };

/** Item + KB context the extract / align samples are derived from. */
type ProcessingSource = {
  name: string;
  expected: string;
  input: {
    item: {
      item_id: string;
      type: KnowledgeExtractInput["item"]["type"];
      source_kind: KnowledgeExtractInput["item"]["source_kind"];
      title: string;
      url?: string;
      content?: string;
      turns?: NonNullable<KnowledgeExtractInput["turns"]>;
      user_highlights: string[];
      user_note: string | null;
      fuzzy_notes: string[];
      requirement: string | null;
    };
    related_entries: SourceEntry[];
    neighbor_entries: KnowledgeAlignInput["neighbor_entries"];
    ignored_names: string[];
    categories: string[];
    kinds: string[];
  };
};

const processingSources: ProcessingSource[] = [
  {
    name: "new",
    expected: "new：知识库没有 MCP，新建词条，可与 Function Calling 建关系",
    input: {
      item: {
        item_id: "item_mcp_intro",
        type: "webpage",
        source_kind: "official_doc",
        title: "Introduction - Model Context Protocol",
        url: "https://modelcontextprotocol.io/introduction",
        content:
          "## What is MCP? [露出:高]\nMCP (Model Context Protocol) is an open protocol that standardizes how applications provide context to LLMs. Think of MCP like a USB-C port for AI applications: just as USB-C provides a standardized way to connect devices to peripherals, MCP provides a standardized way to connect AI models to different data sources and tools.\n## Why MCP? [露出:高]\nMCP helps you build agents and complex workflows on top of LLMs. It provides a growing list of pre-built integrations your LLM can directly plug into, the flexibility to switch between LLM providers, and best practices for securing your data within your infrastructure.\n## General architecture [露出:高]\nMCP follows a client-server architecture where a host application can connect to multiple servers. MCP Hosts are programs like Claude Desktop or IDEs that want to access data through MCP. MCP Clients maintain 1:1 connections with servers. MCP Servers are lightweight programs that each expose specific capabilities (resources, tools, prompts) through the standardized protocol.\n## Get started [露出:低]\nChoose the path that best fits your needs: quickstart for server developers, client developers, or Claude Desktop users.",
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [
        {
          entry_id: "kb_function_calling",
          name: "Function Calling",
          aliases: ["工具调用", "tool use"],
          kind: "concept",
          summary: "模型按 JSON Schema 输出函数名与参数，由程序执行函数并把结果返回给模型。",
          body_markdown: "## 定义\n模型按开发者声明的 JSON Schema 输出要调用的函数名与参数。\n## 流程\n声明工具 → 模型返回调用请求 → 程序执行 → 结果回传模型。"
        }
      ],
      neighbor_entries: [{ entry_id: "kb_agent_loop", name: "Agent Loop", aliases: ["智能体循环"] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "supplement",
    expected: "supplement：给 kb_hitl 打补丁（interrupt 暂停 + 依赖 checkpointer 恢复），可新建 interrupt()",
    input: {
      item: {
        item_id: "item_C",
        type: "webpage",
        source_kind: "official_doc",
        title: "Human-in-the-loop - LangGraph Docs",
        url: "https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/",
        content:
          "## Overview [露出:高]\nHuman-in-the-loop (HITL) workflows integrate human input into automated processes, allowing for decisions, validation, or corrections at key stages.\n## interrupt [露出:高]\nThe interrupt() function pauses graph execution at a specific node and surfaces a value to the client (e.g. a draft for review). To resume, the client invokes the graph again with Command(resume=value); the value becomes the return value of interrupt() inside the node.\n## Requirements [露出:高]\nHITL requires a checkpointer: graph state is persisted at each step, so a paused run can be resumed later — even after the process restarts — from the saved checkpoint using the same thread_id.\n## Design patterns [露出:低]\nApprove or reject an action; edit graph state; review tool calls; validate human input.\n## Caveats [露出:无]\nWhen resuming, the node containing interrupt() re-executes from the beginning, so side effects before interrupt() run again; place side effects after interrupt() or make them idempotent.",
        user_highlights: ["The interrupt() function pauses graph execution at a specific node and surfaces a value to the client"],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [HITL_ENTRY, CHECKPOINT_ENTRY],
      neighbor_entries: [{ entry_id: "kb_langgraph", name: "LangGraph", aliases: [] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "duplicate",
    expected: "duplicate：内容已被 kb_rerank 覆盖",
    input: {
      item: {
        item_id: "item_rerank_blog",
        type: "webpage",
        source_kind: "blog",
        title: "RAG 优化：为什么要加一层 Rerank",
        url: "https://example-blog.dev/rag-rerank",
        content:
          "## 问题 [露出:高]\n向量检索召回的 top-k 结果里常混有相关度不高的片段，直接塞进上下文会干扰回答。\n## 做法 [露出:高]\n先用向量检索粗召回较多候选（如 top-50），再用 cross-encoder 重排模型对「问题-片段」逐对打分，取前几条放入上下文。\n## 常见模型 [露出:高]\nbge-reranker、Cohere Rerank 等。\n## 小结 [露出:高]\n重排用更贵但更准的模型处理少量候选，在成本和效果之间取得平衡。",
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [
        {
          entry_id: "kb_rerank",
          name: "RAG 重排",
          aliases: ["Rerank", "重排序"],
          kind: "method",
          summary: "向量检索粗召回后，用 cross-encoder 对候选逐对打分重排，只把最相关的片段放入上下文。",
          body_markdown:
            "## 定义\n在向量检索之后增加一步重排，提高放入上下文的片段相关度。\n## 流程\n1. 向量检索粗召回较多候选（如 top-50）\n2. cross-encoder 对「查询-片段」逐对打分\n3. 取分数最高的几条放入上下文\n## 常用模型\nbge-reranker、Cohere Rerank、Jina Reranker。\n## 取舍\ncross-encoder 比双塔向量模型准但慢，只用于少量候选，兼顾成本与效果。"
        }
      ],
      neighbor_entries: [{ entry_id: "kb_rag", name: "RAG", aliases: ["检索增强生成"] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "reject-transient",
    expected: "reject / transient：一次性的端口占用报错解法",
    input: {
      item: {
        item_id: "item_vite_port",
        type: "webpage",
        source_kind: "community",
        title: "Vite dev server: Error: listen EADDRINUSE: address already in use :::5173",
        url: "https://stackoverflow.com/questions/vite-eaddrinuse",
        content:
          "## Question [露出:高]\nRunning npm run dev fails with Error: listen EADDRINUSE: address already in use :::5173.\n## Accepted answer [露出:高]\nAnother process is still using port 5173. Run lsof -i :5173 to find the PID and kill -9 <PID>, or start Vite on another port with npm run dev -- --port 5174.",
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [],
      neighbor_entries: [],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "reject-low-information",
    expected: "reject / low_information：空泛的 Agent 趋势文章",
    input: {
      item: {
        item_id: "item_agent_hype",
        type: "webpage",
        source_kind: "blog",
        title: "2026 年，AI Agent 将彻底改变软件开发",
        url: "https://example-media.com/ai-agent-2026",
        content:
          "## 引言 [露出:高]\nAI Agent 正在掀起一场前所未有的革命，每一位开发者都必须拥抱变化，否则就会被时代淘汰。\n## Agent 无处不在 [露出:高]\n从写代码到做设计，从客服到运营，Agent 将渗透到每一个角落，生产力将提升十倍甚至百倍。\n## 未来已来 [露出:低]\n领先的企业已经开始布局，现在就是最好的时机。关注我们，获取更多 AI 前沿资讯。",
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [AGENT_LOOP_ENTRY],
      neighbor_entries: [],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "adopt",
    expected: "采纳模式：内容单薄但不得 reject，应为 new（ReAct）或 supplement（kb_agent_loop）",
    input: {
      item: {
        item_id: "item_react_post",
        type: "webpage",
        source_kind: "community",
        title: "一句话理解 ReAct",
        url: "https://v2ex.example/t/react-agent",
        content:
          "## 正文 [露出:高]\nReAct = Reason + Act。让模型交替输出 Thought / Action / Observation：先想一步，再调用工具，看到结果后再想下一步。相比只做 CoT，推理过程能拿到外部信息，幻觉更少。出处：Yao et al. 2022《ReAct: Synergizing Reasoning and Acting in Language Models》。",
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [AGENT_LOOP_ENTRY],
      neighbor_entries: [{ entry_id: "kb_function_calling", name: "Function Calling", aliases: ["工具调用"] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "user-note",
    expected: "new：按笔记聚焦 workflow vs agent 的区别与「何时不用 agent」，输出 contrasts 关系",
    input: {
      item: {
        item_id: "item_effective_agents",
        type: "webpage",
        source_kind: "blog",
        title: "Building effective agents - Anthropic",
        url: "https://www.anthropic.com/engineering/building-effective-agents",
        content:
          "## What are agents? [露出:高]\nWe draw an architectural distinction between workflows and agents. Workflows are systems where LLMs and tools are orchestrated through predefined code paths. Agents, on the other hand, are systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks.\n## When (and when not) to use agents [露出:高]\nWhen building applications with LLMs, we recommend finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all. Agentic systems often trade latency and cost for better task performance. Workflows offer predictability and consistency for well-defined tasks, whereas agents are the better option when flexibility and model-driven decision-making are needed at scale.\n## Building block: The augmented LLM [露出:低]\nThe basic building block is an LLM enhanced with augmentations such as retrieval, tools, and memory.\n## Workflow: Prompt chaining [露出:低]\nPrompt chaining decomposes a task into a sequence of steps, where each LLM call processes the output of the previous one. You can add programmatic checks (gate) on intermediate steps.\n## Workflow: Routing [露出:无]\nRouting classifies an input and directs it to a specialized followup task.\n## Workflow: Orchestrator-workers [露出:无]\nA central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results.",
        user_highlights: ["Workflows are systems where LLMs and tools are orchestrated through predefined code paths."],
        user_note: "重点：workflow 和 agent 的区别，以及什么时候不该用 agent",
        fuzzy_notes: ["想搞清楚 Agent 架构里有哪些编排模式"],
        requirement: null
      },
      related_entries: [AGENT_LOOP_ENTRY],
      neighbor_entries: [{ entry_id: "kb_function_calling", name: "Function Calling", aliases: ["工具调用"] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  },
  {
    name: "conversation-thread",
    expected: "supplement / new：问答线程，checkpoint 与 interrupt 输出 contrasts 关系，evidence 带 question 与 turn_item_id",
    input: {
      item: {
        item_id: "item_B",
        type: "conversation",
        source_kind: "ai_answer",
        title: "ChatGPT：checkpoint 和 interrupt 有什么区别？",
        turns: [
          {
            turn_item_id: "item_B",
            turn_index: 1,
            question: "checkpoint 和 interrupt 有什么区别？",
            answer:
              "两者解决的问题不同：checkpoint 是持久化机制，LangGraph 在每个 super-step 结束后把图状态存成快照；interrupt 是控制流机制，在节点内调用 interrupt() 会暂停执行、把一个值抛给调用方等待人工输入。interrupt 依赖 checkpoint：没有 checkpointer 时暂停后的状态无处保存，也就无法恢复。"
          },
          {
            turn_item_id: "item_B2",
            turn_index: 2,
            question: "interrupt 恢复时状态从哪里读？",
            answer:
              "从 checkpointer 中读取：用同一个 thread_id 调用 graph.invoke(Command(resume=value), config)，LangGraph 会加载该 thread 最新的 checkpoint，从被中断的节点重新开始执行，此时 interrupt() 返回 resume 传入的值。注意该节点会从头重新执行，interrupt() 之前的代码会再跑一遍。"
          }
        ],
        user_highlights: [],
        user_note: null,
        fuzzy_notes: [],
        requirement: null
      },
      related_entries: [CHECKPOINT_ENTRY, HITL_ENTRY],
      neighbor_entries: [{ entry_id: "kb_langgraph", name: "LangGraph", aliases: [] }],
      ignored_names: [],
      categories: CATEGORIES,
      kinds: KINDS
    }
  }
];

// ⑤ extract → align samples (17), derived from the sources above

const stripExposure = (text: string) => text.replace(/ \[露出:[^\]]+\]/g, "");

function sourcesOf(input: ProcessingSource["input"]): SourceText[] {
  if (input.item.content) return [{ turnItemId: null, text: stripExposure(input.item.content) }];
  return (input.item.turns ?? []).map((turn) => ({ turnItemId: turn.turn_item_id, text: turn.answer }));
}

export const knowledgeExtractSamples: Sample<KnowledgeExtractInput, KnowledgeExtractOutput>[] = processingSources.map(({ name, input }) => {
  const sources = sourcesOf(input);
  const lowInformation = name === "reject-low-information";
  const instructions = [
    ...(input.item.user_note ? [{ kind: "item_note" as const, text: input.item.user_note }] : []),
    ...input.item.fuzzy_notes.map((text) => ({ kind: "fuzzy_note" as const, text })),
    ...(input.item.requirement ? [{ kind: "requirement" as const, text: input.item.requirement }] : [])
  ];
  return {
    name,
    expected: lowInformation ? "无知识片段（全部 removed）" : "片段逐字来自原文，原文章节都被片段引用或列入 removed",
    input: {
      step: "extract",
      item: { item_id: input.item.item_id, type: input.item.type, source_kind: input.item.source_kind, title: input.item.title, url: input.item.url ?? null },
      text: input.item.content ? stripExposure(input.item.content) : null,
      turns: input.item.turns ?? null,
      user_highlights: input.item.user_highlights,
      instructions,
      ignored_names: input.ignored_names,
      feedback: null
    },
    check: (output) =>
      lowInformation
        ? output.fragments.length
          ? [`应无片段，实际 ${output.fragments.length} 个`]
          : []
        : checkExtract(output, sources, instructions.length > 0).problems
  };
});

/** Fragments are the source sections (≥ 50 chars) cut verbatim; candidates carry their section lists. */
export const knowledgeAlignSamples: Sample<KnowledgeAlignInput, KnowledgeAlignOutput>[] = processingSources
  .filter((sample) => !/^(duplicate|reject)/.test(sample.name))
  .map(({ name, expected, input }) => {
    const fragments = sourceSections(sourcesOf(input)).map((section, index) => {
      const heading = section.heading?.replace(/^#+\s*/, "") ?? input.item.title;
      return { fragment_id: `f${index + 1}`, concept: heading, heading, excerpt: section.body.trim().slice(0, 300) };
    });
    const candidates = input.related_entries.map((entry) => ({
      entry_id: entry.entry_id,
      name: entry.name,
      aliases: entry.aliases,
      kind: entry.kind,
      summary: entry.summary,
      sections: entrySections(entry.body_markdown ?? "").map((section) => ({
        section_id: section.sectionId,
        heading: section.heading,
        excerpt: section.markdown.slice(0, 200)
      }))
    }));
    const names = [...candidates, ...input.neighbor_entries].flatMap((entry) => [entry.name, ...entry.aliases]);
    const known = {
      candidates: new Map(candidates.map((entry) => [entry.entry_id, new Set(entry.sections.map((section) => section.section_id))])),
      neighborIds: new Set(input.neighbor_entries.map((entry) => entry.entry_id)),
      takenNames: new Set(names.map(normalizeEntryName)),
      ignoredNames: new Set(input.ignored_names.map(normalizeEntryName))
    };
    return {
      name,
      expected,
      input: {
        step: "align",
        item: { item_id: input.item.item_id, type: input.item.type, source_kind: input.item.source_kind, title: input.item.title },
        fragments,
        candidate_entries: candidates,
        neighbor_entries: input.neighbor_entries,
        categories: input.categories,
        kinds: input.kinds,
        ignored_names: input.ignored_names,
        feedback: null
      },
      check: (output) =>
        checkAlign(
          output,
          fragments.map((fragment) => fragment.fragment_id),
          known
        )
    };
  });
