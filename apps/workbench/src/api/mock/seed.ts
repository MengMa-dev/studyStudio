import type {
  CollectorSettings,
  ExclusionRule,
  HomeSummaryResponse,
  InboxItemDetail,
  InboxListRow,
  LearnerProfile,
  Note,
  OverviewResponse,
  PresenceResponse,
  TimelineDay,
  TrashEntry
} from "@study-studio/shared";
import { CAPTURE_PRESETS, DEFAULT_ACTIVITY_TRACKING, DEFAULT_CONVERSATION_PLATFORMS } from "@study-studio/shared";

const DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number, hour: number, minute: number): string {
  const d = new Date(Date.UTC(2026, 9, 2, hour, minute, 0));
  d.setTime(d.getTime() - days * DAY);
  return d.toISOString();
}

function dayLabel(daysAgo: number): { day: string; label: string } {
  if (daysAgo === 0) return { day: "2026-10-02", label: "今天 · 10月2日 周五" };
  if (daysAgo === 1) return { day: "2026-10-01", label: "昨天 · 10月1日 周四" };
  if (daysAgo === 2) return { day: "2026-09-30", label: "周三 · 9月30日" };
  return { day: isoDaysAgo(daysAgo, 0, 0).slice(0, 10), label: isoDaysAgo(daysAgo, 0, 0).slice(0, 10) };
}

export type MockItem = InboxItemDetail & {
  contentHash: string | null;
  originalMarkdown: string | null;
  deletedAt: string | null;
};

export type MockState = {
  items: MockItem[];
  notes: Note[];
  trash: Array<TrashEntry & { snapshot: { items: MockItem[]; notes: Note[] } }>;
  timeline: TimelineDay[];
  overview: OverviewResponse;
  presence: PresenceResponse;
  settings: CollectorSettings;
  rules: ExclusionRule[];
  profile: LearnerProfile;
  home: HomeSummaryResponse;
  dataInfo: {
    address: string;
    uptimeSeconds: number;
    sqliteVersion: string;
    dataDir: string;
    sizeBytes: number;
    itemCount: number;
    extensionConnected: boolean;
    extensionLastSeenAt: string | null;
    extensionPendingCount: number;
    pairingToken: string;
  };
  onboardingDone: boolean;
  undoStack: Array<{ trashId: string }>;
};

function makeItem(partial: Partial<MockItem> & Pick<MockItem, "id" | "type" | "title" | "capturedAt">): MockItem {
  return {
    url: null,
    site: null,
    reason: null,
    readStatus: "unread",
    organizeStatus: "pending",
    dirty: false,
    tags: [],
    readingTotalSeconds: 0,
    readingSessionCount: 0,
    lastReadAt: null,
    markdown: null,
    question: null,
    reasoning: null,
    editedAt: null,
    unusedNoteCount: 0,
    readingSessions: [],
    notes: [],
    relatedEntries: [],
    contentHash: null,
    originalMarkdown: null,
    deletedAt: null,
    ...partial
  };
}

export function createSeedState(): MockState {
  const items: MockItem[] = [
    makeItem({
      id: "item-p1",
      type: "webpage",
      title: "从零实现 HNSW：分层可导航小世界图",
      url: "https://juejin.cn/post/7301234567890",
      site: "掘金",
      capturedAt: isoDaysAgo(0, 16, 21),
      reason: "threshold",
      readStatus: "unread",
      organizeStatus: "pending",
      tags: ["向量检索", "HNSW"],
      readingTotalSeconds: 412,
      readingSessionCount: 1,
      lastReadAt: isoDaysAgo(0, 16, 21),
      markdown:
        "## 为什么需要 HNSW\n\n暴力检索需要把查询向量与库中每个向量计算距离，复杂度 $O(N)$。\n\n```python\ndef search(q, ef):\n    ep = entry_point\n    for layer in range(top, 0, -1):\n        ep = greedy(q, ep, layer)\n    return beam_search(q, ep, ef, layer=0)\n```\n\n## 关键参数\n\nM 控制每个节点的邻居数，efConstruction 影响建图质量。",
      readingSessions: [{ id: "rs-p1-1", startedAt: isoDaysAgo(0, 16, 14), seconds: 412, isFirst: true }],
      relatedEntries: [{ id: "kb-hnsw", name: "HNSW", mastery: 0.2 }]
    }),
    makeItem({
      id: "item-p2",
      type: "webpage",
      title: "交叉编码器和双塔模型应该怎么选？",
      url: "https://www.zhihu.com/question/2067930819/answer/2087853688",
      site: "知乎",
      capturedAt: isoDaysAgo(0, 14, 2),
      reason: "copy",
      readStatus: "read",
      organizeStatus: "ingested",
      tags: ["重排", "交叉编码器"],
      readingTotalSeconds: 1265,
      readingSessionCount: 2,
      lastReadAt: isoDaysAgo(0, 15, 30),
      markdown:
        "双塔模型把查询和文档分别编码成向量，文档向量可以离线批量计算。\n\n交叉编码器则把查询和文档拼接在一起送进同一个模型。\n\n> 实践中最常见的组合是：双塔负责高召回率的粗筛，交叉编码器负责高精度的精排。",
      readingSessions: [
        { id: "rs-p2-1", startedAt: isoDaysAgo(0, 13, 40), seconds: 845, isFirst: true },
        { id: "rs-p2-2", startedAt: isoDaysAgo(0, 15, 30), seconds: 420, isFirst: false }
      ],
      relatedEntries: [
        { id: "kb-cross", name: "交叉编码器", mastery: 0.65 },
        { id: "kb-bi", name: "双塔模型", mastery: 0.5 }
      ]
    }),
    makeItem({
      id: "item-q1",
      type: "conversation",
      title: "什么是交叉编码器？",
      url: "https://chat.deepseek.com/a/chat/s/xyz",
      site: "DeepSeek",
      capturedAt: isoDaysAgo(0, 13, 35),
      reason: "answer_completed",
      readStatus: "read",
      organizeStatus: "ingested",
      tags: ["交叉编码器"],
      question: "什么是交叉编码器？",
      reasoning: "用户在问交叉编码器，应该对比双塔模型说明……",
      markdown:
        "交叉编码器（Cross-Encoder）把查询和文档拼接后一起送入 Transformer 编码，直接输出相关性分数。\n\n```js\nscores = model.predict([(query, doc) for doc in candidates])\n```\n\n因为每对都要单独计算，通常只对召回得到的少量候选使用。",
      relatedEntries: [{ id: "kb-cross", name: "交叉编码器", mastery: 0.65 }]
    }),
    makeItem({
      id: "item-q2",
      type: "conversation",
      title: "向量召回和重排有什么区别？",
      url: "https://chatgpt.com/c/abc",
      site: "ChatGPT",
      capturedAt: isoDaysAgo(1, 21, 12),
      reason: "answer_completed",
      readStatus: "read",
      organizeStatus: "ingested",
      tags: ["向量检索", "重排"],
      question: "向量召回和重排有什么区别？",
      markdown: "召回负责粗筛，重排负责精排。\n\n召回阶段使用 ANN 索引在毫秒级返回几百条候选；重排阶段用更重的模型对候选逐一打分。"
    }),
    makeItem({
      id: "item-p3",
      type: "webpage",
      title: "IntersectionObserver - Web API | MDN",
      url: "https://developer.mozilla.org/zh-CN/docs/Web/API/IntersectionObserver",
      site: "MDN",
      capturedAt: isoDaysAgo(1, 10, 48),
      reason: "threshold",
      readStatus: "unread",
      organizeStatus: "pending",
      tags: ["前端"],
      readingTotalSeconds: 236,
      readingSessionCount: 1,
      markdown: "IntersectionObserver 接口提供了一种异步观察目标元素与其祖先元素或顶级文档视口交叉状态的方法。",
      readingSessions: [{ id: "rs-p3-1", startedAt: isoDaysAgo(1, 10, 44), seconds: 236, isFirst: true }]
    }),
    makeItem({
      id: "item-p4",
      type: "webpage",
      title: "Okapi BM25 - 维基百科",
      url: "https://zh.wikipedia.org/wiki/Okapi_BM25",
      site: "Wikipedia",
      capturedAt: isoDaysAgo(2, 20, 15),
      reason: "note",
      readStatus: "read",
      organizeStatus: "ingested",
      tags: ["BM25", "信息检索"],
      readingTotalSeconds: 980,
      readingSessionCount: 2,
      markdown: "BM25 是搜索引擎根据查询词与文档的相关性对文档进行排序的一种算法。",
      readingSessions: [
        { id: "rs-p4-1", startedAt: isoDaysAgo(2, 20, 5), seconds: 610, isFirst: true },
        { id: "rs-p4-2", startedAt: isoDaysAgo(1, 9, 10), seconds: 370, isFirst: false }
      ],
      relatedEntries: [{ id: "kb-bm25", name: "BM25", mastery: 0.75 }]
    }),
    makeItem({
      id: "item-p5",
      type: "webpage",
      title: "example/rag-toolkit：开箱即用的 RAG 工具集",
      url: "https://github.com/example/rag-toolkit",
      site: "GitHub",
      capturedAt: isoDaysAgo(2, 16, 30),
      reason: "selection",
      readStatus: "unread",
      organizeStatus: "pending",
      tags: ["RAG"],
      readingTotalSeconds: 145,
      readingSessionCount: 1,
      markdown: "```bash\nnpm install rag-toolkit\n```\n\nrag-toolkit 提供文档切块、向量化、混合检索与重排的完整流水线。",
      readingSessions: [{ id: "rs-p5-1", startedAt: isoDaysAgo(2, 16, 28), seconds: 145, isFirst: true }]
    })
  ];

  const notes: Note[] = [
    {
      id: "note-fuzzy-1",
      scope: "fuzzy",
      targetId: null,
      text: "今天想搞清楚重排到底该用什么模型，召回和重排要分开理解",
      origin: "extension",
      usedAt: null,
      createdAt: isoDaysAgo(0, 13, 33),
      updatedAt: null
    },
    {
      id: "note-item-p2-1",
      scope: "item",
      targetId: "item-p2",
      text: "重排模型的输入长度要控制在 512 token 内，长文档先切块。",
      origin: "extension",
      usedAt: isoDaysAgo(0, 14, 30),
      createdAt: isoDaysAgo(0, 14, 5),
      updatedAt: null
    },
    {
      id: "note-item-p4-1",
      scope: "item",
      targetId: "item-p4",
      text: "混合检索时 BM25 分数需要先归一化再和向量分数融合。",
      origin: "workbench",
      usedAt: null,
      createdAt: isoDaysAgo(2, 20, 20),
      updatedAt: null
    },
    {
      id: "note-entry-1",
      scope: "entry",
      targetId: "kb-cross",
      text: "常用 bge-reranker、ms-marco-MiniLM",
      origin: "derived",
      usedAt: isoDaysAgo(0, 14, 30),
      createdAt: isoDaysAgo(0, 14, 30),
      updatedAt: null,
      derivedFrom: "note-item-p2-1"
    }
  ];

  for (const item of items) {
    item.notes = notes.filter((n) => n.scope === "item" && n.targetId === item.id);
    item.unusedNoteCount = item.notes.filter((n) => !n.usedAt).length + (item.dirty ? 1 : 0);
  }

  const d0 = dayLabel(0);
  const d1 = dayLabel(1);
  const d2 = dayLabel(2);

  const timeline: TimelineDay[] = [
    {
      day: d0.day,
      label: d0.label,
      minutes: 102,
      rows: [
        {
          id: "tl-p1",
          type: "webpage",
          startedAt: isoDaysAgo(0, 16, 14),
          title: "从零实现 HNSW：分层可导航小世界图",
          site: "掘金",
          itemId: "item-p1",
          noteId: null,
          durationSeconds: 412,
          tags: ["已收集"]
        },
        {
          id: "tl-q1",
          type: "conversation",
          startedAt: isoDaysAgo(0, 13, 35),
          title: "DeepSeek · 什么是交叉编码器？",
          site: "DeepSeek",
          itemId: "item-q1",
          noteId: null,
          durationSeconds: 60,
          tags: ["已回答"]
        },
        {
          id: "tl-p2",
          type: "webpage",
          startedAt: isoDaysAgo(0, 13, 40),
          title: "交叉编码器和双塔模型应该怎么选？",
          site: "知乎",
          itemId: "item-p2",
          noteId: null,
          durationSeconds: 1265,
          tags: ["已收集", "阅读 2 次"]
        },
        {
          id: "tl-fuzzy-1",
          type: "fuzzy",
          startedAt: isoDaysAgo(0, 13, 33),
          title: "今天想搞清楚重排到底该用什么模型，召回和重排要分开理解",
          site: null,
          itemId: null,
          noteId: "note-fuzzy-1",
          durationSeconds: null,
          tags: ["模糊备注"]
        }
      ]
    },
    {
      day: d1.day,
      label: d1.label,
      minutes: 130,
      rows: [
        {
          id: "tl-q2",
          type: "conversation",
          startedAt: isoDaysAgo(1, 21, 5),
          title: "ChatGPT · 向量召回和重排有什么区别？",
          site: "ChatGPT",
          itemId: "item-q2",
          noteId: null,
          durationSeconds: 420,
          tags: ["已回答"]
        },
        {
          id: "tl-p3",
          type: "webpage",
          startedAt: isoDaysAgo(1, 10, 44),
          title: "IntersectionObserver - Web API | MDN",
          site: "MDN",
          itemId: "item-p3",
          noteId: null,
          durationSeconds: 236,
          tags: ["已收集"]
        }
      ]
    },
    {
      day: d2.day,
      label: d2.label,
      minutes: 95,
      rows: [
        {
          id: "tl-p4",
          type: "webpage",
          startedAt: isoDaysAgo(2, 20, 5),
          title: "Okapi BM25 - 维基百科",
          site: "Wikipedia",
          itemId: "item-p4",
          noteId: null,
          durationSeconds: 980,
          tags: ["已收集"]
        },
        {
          id: "tl-p5",
          type: "webpage",
          startedAt: isoDaysAgo(2, 16, 28),
          title: "example/rag-toolkit：开箱即用的 RAG 工具集",
          site: "GitHub",
          itemId: "item-p5",
          noteId: null,
          durationSeconds: 145,
          tags: ["已收集"]
        }
      ]
    }
  ];

  const profile: LearnerProfile = {
    role: "前端开发",
    directions: [{ id: "dir-1", text: "Agent 架构", expiresAt: "2026-11-01" }]
  };

  const overview: OverviewResponse = {
    today: { minutes: 102, pages: 4, qa: 2, notes: 2, streak: 5 },
    week: [
      { day: "周五", minutes: 64 },
      { day: "周六", minutes: 18 },
      { day: "周日", minutes: 0 },
      { day: "周一", minutes: 95 },
      { day: "周二", minutes: 72 },
      { day: "周三", minutes: 130 },
      { day: "今天", minutes: 102 }
    ],
    sources: [
      { name: "知乎", minutes: 142 },
      { name: "掘金", minutes: 96 },
      { name: "DeepSeek", minutes: 88 },
      { name: "ChatGPT", minutes: 61 },
      { name: "MDN", minutes: 33 }
    ],
    pending: { unread: 3, pendingOrganize: 3, weakEntries: 4 }
  };

  const rules: ExclusionRule[] = [
    {
      id: "rule-1",
      kind: "domain",
      value: "news.ycombinator.com",
      note: "浏览列表，不采集",
      createdAt: isoDaysAgo(10, 12, 0)
    },
    {
      id: "rule-2",
      kind: "url_prefix",
      value: "https://github.com/notifications",
      note: "通知页",
      createdAt: isoDaysAgo(8, 9, 0)
    }
  ];

  const settings: CollectorSettings = {
    captureRules: {
      preset: "standard",
      ...CAPTURE_PRESETS.standard,
      captureFromSearch: true,
      aiConversationWindowMinutes: 5
    },
    activityTracking: { ...DEFAULT_ACTIVITY_TRACKING },
    conversationPlatforms: { ...DEFAULT_CONVERSATION_PLATFORMS },
    exclusionRules: rules,
    builtinListPageRules: ["github.com/*/issues", "github.com/*/pulls", "*/search*", "*/tag/*", "*/category/*"],
    domainCategoryVersion: 1
  };

  return {
    items,
    notes,
    trash: [],
    timeline,
    overview,
    presence: {
      active: true,
      title: "从零实现 HNSW：分层可导航小世界图",
      site: "掘金",
      url: "https://juejin.cn/post/7301234567890",
      seconds: 412,
      captured: true,
      updatedAt: isoDaysAgo(0, 16, 21)
    },
    settings,
    rules,
    profile,
    home: {
      greetingPeriod: "afternoon",
      today: overview.today,
      pending: overview.pending,
      knowledgeEntryCount: 12,
      profile
    },
    dataInfo: {
      address: "127.0.0.1:43118",
      uptimeSeconds: 3600,
      sqliteVersion: "3.51.2",
      dataDir: "~/StudyStudioData",
      sizeBytes: 90_600_000,
      itemCount: items.length,
      extensionConnected: true,
      extensionLastSeenAt: isoDaysAgo(0, 16, 20),
      extensionPendingCount: 0,
      pairingToken: "1f3c9a72-5be4-4d1e-a0c6-9b8e2f7d4c11"
    },
    onboardingDone: true,
    undoStack: []
  };
}

export function toListRow(item: MockItem): InboxListRow {
  return {
    kind: "item",
    id: item.id,
    type: item.type,
    title: item.title,
    url: item.url,
    site: item.site,
    capturedAt: item.capturedAt,
    readStatus: item.readStatus,
    organizeStatus: item.organizeStatus,
    dirty: item.dirty,
    tags: item.tags,
    readingTotalSeconds: item.readingTotalSeconds,
    readingSessionCount: item.readingSessionCount
  };
}

export function encodeCursor(capturedAt: string, id: string): string {
  const json = JSON.stringify({ capturedAt, id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): { capturedAt: string; id: string } {
  const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  return JSON.parse(json) as { capturedAt: string; id: string };
}
