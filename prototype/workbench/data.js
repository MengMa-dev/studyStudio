/* Mock data shaped like StudyStudioData: inbox items, timeline events per day, knowledge graph + wiki, settings. */
window.DATA = {
  connection: { extensionLastSeen: "1 分钟前", pending: 0, token: "1f3c9a72-5be4-4d1e-a0c6-9b8e2f7d4c11", dataDir: "~/StudyStudioData", size: "86.4 MB", items: 128 },
  live: { title: "从零实现 HNSW：分层可导航小世界图", site: "掘金", seconds: 412, captured: true },
  stats: {
    today: { minutes: 102, pages: 4, qa: 6, notes: 2 },
    week: [
      { day: "周五", minutes: 64 }, { day: "周六", minutes: 18 }, { day: "周日", minutes: 0 },
      { day: "周一", minutes: 95 }, { day: "周二", minutes: 72 }, { day: "周三", minutes: 130 }, { day: "今天", minutes: 102 }
    ],
    sources: [
      { name: "知乎", minutes: 142 }, { name: "掘金", minutes: 96 }, { name: "DeepSeek", minutes: 88 },
      { name: "ChatGPT", minutes: 61 }, { name: "MDN", minutes: 33 }, { name: "PDF 文档", minutes: 58 }
    ],
    streak: 5
  },
  sites: {
    "知乎": { color: "#0066ff", short: "知" },
    "掘金": { color: "#1e80ff", short: "掘" },
    "MDN": { color: "#1b1b1b", short: "M" },
    "GitHub": { color: "#24292f", short: "GH" },
    "Wikipedia": { color: "#636466", short: "W" },
    "CSDN": { color: "#fc5531", short: "C" },
    "DeepSeek": { color: "#4d6bfe", short: "DS" },
    "ChatGPT": { color: "#10a37f", short: "GPT" },
    "PDF": { color: "#e03131", short: "PDF" },
    "PPT": { color: "#e8590c", short: "PPT" }
  },
  items: [
    {
      id: "p1", type: "webpage", site: "掘金", title: "从零实现 HNSW：分层可导航小世界图",
      url: "https://juejin.cn/post/7301234567890", capturedAt: "今天 16:21", reason: "threshold", status: "unread",
      tags: ["向量检索", "HNSW"], reading: { total: 412, sessions: [{ at: "今天 16:14", seconds: 412, first: true }] },
      organized: false, concepts: ["HNSW", "ANN"],
      body: [
        ["h", "为什么需要 HNSW"],
        ["p", "暴力检索需要把查询向量与库中每个向量计算距离，复杂度 O(N)。当向量规模达到千万级时，延迟不可接受，于是出现了近似最近邻（ANN）算法。"],
        ["p", "HNSW 把向量组织成多层图：上层稀疏、下层稠密。查询从最上层的入口点开始贪心搜索，逐层下降，在底层得到候选集。"],
        ["code", "def search(q, ef):\n    ep = entry_point\n    for layer in range(top, 0, -1):\n        ep = greedy(q, ep, layer)\n    return beam_search(q, ep, ef, layer=0)"],
        ["h", "关键参数"],
        ["p", "M 控制每个节点的邻居数，efConstruction 影响建图质量，efSearch 在查询时权衡召回率与延迟。"]
      ]
    },
    {
      id: "p2", type: "webpage", site: "知乎", title: "交叉编码器和双塔模型应该怎么选？",
      url: "https://www.zhihu.com/question/2067930819/answer/2087853688", capturedAt: "今天 14:02", reason: "copy", status: "read",
      tags: ["重排", "交叉编码器"], reading: { total: 1265, sessions: [{ at: "今天 13:40", seconds: 845, first: true }, { at: "今天 15:30", seconds: 420 }] },
      organized: true, concepts: ["交叉编码器", "双塔模型", "重排"],
      summary: "双塔模型分别编码查询与文档，文档向量可离线计算，适合召回；交叉编码器拼接后联合编码，精度高但计算量随候选数线性增长，适合重排。两者组合是工业界主流。",
      points: ["双塔：离线建索引，线上只编码查询", "交叉编码器：注意力在查询与文档间充分交互", "组合：双塔粗筛 → 交叉编码器精排"],
      notes: ["重排模型的输入长度要控制在 512 token 内，长文档先切块。"],
      body: [
        ["p", "双塔模型把查询和文档分别编码成向量，文档向量可以离线批量计算并写入向量索引，线上只需要编码一次查询，再做近似最近邻检索。"],
        ["p", "交叉编码器则把查询和文档拼接在一起送进同一个模型，注意力可以在两者之间充分交互，打分精度明显更高。"],
        ["blockquote", "实践中最常见的组合是：双塔负责高召回率的粗筛，交叉编码器负责高精度的精排。"]
      ]
    },
    {
      id: "q1", type: "conversation", site: "DeepSeek", title: "什么是交叉编码器？",
      url: "https://chat.deepseek.com/a/chat/s/xyz", capturedAt: "今天 13:35", reason: "answer_completed", status: "read",
      tags: ["交叉编码器"], organized: true, concepts: ["交叉编码器"],
      summary: "交叉编码器把查询和文档拼接后一起编码输出相关性分数，常用于重排阶段。",
      points: ["输入：[CLS] query [SEP] doc", "输出：相关性分数", "用途：重排"],
      question: "什么是交叉编码器？",
      reasoning: "用户在问交叉编码器，应该对比双塔模型说明……",
      answer: [
        ["p", "交叉编码器（Cross-Encoder）把查询和文档拼接后一起送入 Transformer 编码，直接输出相关性分数。"],
        ["code", "scores = model.predict([(query, doc) for doc in candidates])"],
        ["p", "因为每对都要单独计算，通常只对召回得到的少量候选使用。"]
      ]
    },
    {
      id: "q2", type: "conversation", site: "ChatGPT", title: "向量召回和重排有什么区别？",
      url: "https://chatgpt.com/c/abc", capturedAt: "昨天 21:12", reason: "answer_completed", status: "read",
      tags: ["向量检索", "重排"], organized: true, concepts: ["向量检索", "重排"],
      summary: "召回负责从海量文档中快速筛出候选，追求高召回率；重排对候选精细打分，追求高精度。",
      points: ["召回：快、粗、高召回率", "重排：慢、精、高精度"],
      question: "向量召回和重排有什么区别？",
      answer: [
        ["p", "召回负责粗筛，重排负责精排。"],
        ["p", "召回阶段使用 ANN 索引在毫秒级返回几百条候选；重排阶段用更重的模型对候选逐一打分。"]
      ]
    },
    {
      id: "p3", type: "webpage", site: "MDN", title: "IntersectionObserver - Web API | MDN",
      url: "https://developer.mozilla.org/zh-CN/docs/Web/API/IntersectionObserver", capturedAt: "昨天 10:48", reason: "threshold", status: "unread",
      tags: ["前端"], reading: { total: 236, sessions: [{ at: "昨天 10:44", seconds: 236, first: true }] },
      organized: false, concepts: [],
      body: [["p", "IntersectionObserver 接口提供了一种异步观察目标元素与其祖先元素或顶级文档视口交叉状态的方法。"]]
    },
    {
      id: "p4", type: "webpage", site: "Wikipedia", title: "Okapi BM25 - 维基百科",
      url: "https://zh.wikipedia.org/wiki/Okapi_BM25", capturedAt: "周三 20:15", reason: "note", status: "read",
      tags: ["BM25", "信息检索"], reading: { total: 980, sessions: [{ at: "周三 20:05", seconds: 610, first: true }, { at: "周四 09:10", seconds: 370 }] },
      organized: true, concepts: ["BM25", "混合检索"],
      summary: "BM25 是基于词频与逆文档频率的排序函数，通过 k1、b 两个参数控制词频饱和与文档长度归一化。",
      points: ["IDF 衡量词的区分度", "k1 控制词频饱和速度", "b 控制文档长度归一化强度"],
      notes: ["混合检索时 BM25 分数需要先归一化再和向量分数融合。"],
      body: [["p", "BM25 是搜索引擎根据查询词与文档的相关性对文档进行排序的一种算法。"]]
    },
    {
      id: "p5", type: "webpage", site: "GitHub", title: "example/rag-toolkit：开箱即用的 RAG 工具集",
      url: "https://github.com/example/rag-toolkit", capturedAt: "周三 16:30", reason: "selection", status: "unread",
      tags: ["RAG"], reading: { total: 145, sessions: [{ at: "周三 16:28", seconds: 145, first: true }] },
      organized: false, concepts: ["RAG"],
      body: [["code", "npm install rag-toolkit"], ["p", "rag-toolkit 提供文档切块、向量化、混合检索与重排的完整流水线。"]]
    },
    {
      id: "d1", type: "document", site: "PDF", title: "Attention Is All You Need.pdf",
      url: "", capturedAt: "周二 19:40", reason: "document", status: "read",
      tags: ["Transformer"], reading: { total: 3480, sessions: [{ at: "周二 19:40", seconds: 2100, first: true }, { at: "今天 09:15", seconds: 1380 }] },
      organized: true, concepts: ["Transformer", "注意力机制"], pages: 15, readPages: 9,
      summary: "提出完全基于注意力机制的 Transformer 架构，摒弃循环与卷积，在机器翻译上取得 SOTA 且训练更快。",
      points: ["Scaled Dot-Product Attention", "Multi-Head Attention", "位置编码"],
      body: [["p", "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks..."]]
    },
    {
      id: "d2", type: "document", site: "PPT", title: "RAG 系统设计分享.pptx",
      url: "", capturedAt: "周一 15:00", reason: "document", status: "unread",
      tags: ["RAG"], reading: { total: 640, sessions: [{ at: "周一 15:00", seconds: 640, first: true }] },
      organized: false, concepts: ["RAG", "混合检索"], pages: 24, readPages: 11,
      body: [["p", "第 1 页：RAG 系统设计 —— 从检索到生成"]]
    }
  ],
  /* Raw learning events per day. Events with `item` belong to an inbox item; events without one are fuzzy notes. */
  timeline: [
    {
      day: "今天", date: "10月2日 周五", minutes: 102,
      events: [
        { time: "16:21", type: "webpage_captured", text: "收集网页 · 从零实现 HNSW：分层可导航小世界图", item: "p1" },
        { time: "13:33", type: "user_note", text: "备注 · 今天想搞清楚重排到底该用什么模型，召回和重排要分开理解", source: "扩展 · 浮窗备注" },
        { time: "13:35", type: "user_message_sent", text: "提问 DeepSeek · 什么是交叉编码器？", item: "q1" },
        { time: "13:36", type: "assistant_response_completed", text: "回答完成 · 交叉编码器把查询和文档拼接后…", item: "q1" },
        { time: "14:02", type: "webpage_captured", text: "收集网页 · 交叉编码器和双塔模型应该怎么选？", item: "p2" },
        { time: "14:05", type: "user_note", text: "备注 · 重排模型的输入长度要控制在 512 token 内", item: "p2" },
        { time: "14:12", type: "reading_session_closed", text: "阅读 14 分钟 · 交叉编码器和双塔模型应该怎么选？", item: "p2" },
        { time: "15:37", type: "reading_session_closed", text: "再次阅读 7 分钟 · 交叉编码器和双塔模型应该怎么选？", item: "p2" },
        { time: "09:38", type: "reading_session_closed", text: "阅读 23 分钟 · Attention Is All You Need.pdf（第 6–9 页）", item: "d1" }
      ]
    },
    {
      day: "昨天", date: "10月1日 周四", minutes: 130,
      events: [
        { time: "21:05", type: "user_message_sent", text: "提问 ChatGPT · 向量召回和重排有什么区别？", item: "q2" },
        { time: "21:12", type: "assistant_response_completed", text: "回答完成 · 召回负责粗筛，重排负责精排", item: "q2" },
        { time: "10:48", type: "webpage_captured", text: "收集网页 · IntersectionObserver - Web API | MDN", item: "p3" },
        { time: "09:16", type: "reading_session_closed", text: "再次阅读 6 分钟 · Okapi BM25 - 维基百科", item: "p4" }
      ]
    }
  ],
  graph: {
    nodes: [
      { id: "RAG", x: 470, y: 90, mastery: 0.6, desc: "检索增强生成：先检索相关资料，再交给大模型生成回答。" },
      { id: "向量检索", x: 270, y: 220, mastery: 0.7, desc: "把文本编码为向量，按相似度检索最相关的文档。" },
      { id: "重排", x: 650, y: 220, mastery: 0.55, desc: "对召回候选做精细打分并重新排序。" },
      { id: "Embedding", x: 120, y: 340, mastery: 0.5, desc: "把文本映射到稠密向量空间的表示。" },
      { id: "ANN", x: 300, y: 380, mastery: 0.4, desc: "近似最近邻搜索，以少量精度换取数量级的速度提升。" },
      { id: "HNSW", x: 300, y: 520, mastery: 0.2, desc: "分层可导航小世界图，最常用的 ANN 索引之一。" },
      { id: "BM25", x: 470, y: 330, mastery: 0.75, desc: "基于词频和逆文档频率的经典排序函数。" },
      { id: "混合检索", x: 470, y: 470, mastery: 0.35, desc: "融合关键词检索与向量检索的结果。" },
      { id: "交叉编码器", x: 640, y: 380, mastery: 0.65, desc: "查询与文档拼接后联合编码，输出相关性分数。（已手动补充：常用 bge-reranker、ms-marco-MiniLM）", userEdited: true },
      { id: "双塔模型", x: 800, y: 330, mastery: 0.5, desc: "查询与文档分别编码，文档向量可离线计算。" },
      { id: "Transformer", x: 760, y: 520, mastery: 0.45, desc: "完全基于注意力机制的序列模型架构。" },
      { id: "注意力机制", x: 900, y: 450, mastery: 0.4, desc: "按相关性对输入加权聚合信息的机制。" }
    ],
    edges: [
      ["向量检索", "RAG", "part_of"], ["重排", "RAG", "part_of"], ["Embedding", "向量检索", "prerequisite"],
      ["ANN", "向量检索", "part_of"], ["HNSW", "ANN", "part_of"], ["BM25", "混合检索", "part_of"],
      ["向量检索", "混合检索", "part_of"], ["交叉编码器", "重排", "part_of"], ["双塔模型", "交叉编码器", "contrasts"],
      ["双塔模型", "向量检索", "related"], ["Transformer", "交叉编码器", "prerequisite"], ["注意力机制", "Transformer", "prerequisite"],
      ["BM25", "向量检索", "contrasts"]
    ]
  },
  wiki: {
    categories: [
      { id: "rag", name: "RAG 系统", desc: "检索增强生成的整体架构与各个环节" },
      { id: "retrieval", name: "检索基础", desc: "关键词检索、向量检索与索引结构" },
      { id: "model", name: "模型与架构", desc: "支撑检索与生成的模型原理" }
    ],
    kinds: { concept: "概念", method: "方法", algorithm: "算法", model: "模型", paper: "论文" },
    /* AI-organized article body per entry; entries without one fall back to points. */
    content: {
      "RAG": [
        ["p", "RAG（Retrieval-Augmented Generation，检索增强生成）在大模型生成回答之前，先从外部知识库检索与问题相关的资料，把资料作为上下文一起交给模型。模型不再只依赖训练时记住的知识，因此能回答私有、最新的信息，并且答案可以溯源到具体文档。"],
        ["h", "典型流程"],
        ["ul", ["离线：文档切块 → 向量化（Embedding）→ 写入向量索引，同时建立关键词索引", "在线：查询改写 → 召回（向量检索 / 混合检索）→ 重排 → 拼接上下文 → 生成", "输出：回答附带引用来源，便于核对"]],
        ["h", "效果取决于什么"],
        ["p", "生成质量的上限由检索质量决定：召回阶段要保证相关文档进入候选集（高召回率），重排阶段要把最相关的几条排到前面（高精度）。你在知乎读到的工业界做法是「双塔粗筛 + 交叉编码器精排」。"],
        ["h", "和微调的区别"],
        ["p", "微调把知识写进模型参数，更新成本高且难以溯源；RAG 把知识放在外部，更新文档即可生效。两者可以结合：微调改变模型的表达方式，RAG 提供事实。"]
      ],
      "重排": [
        ["p", "重排（Rerank）是检索流水线的第二阶段：对召回得到的几十到几百条候选，用更精细但更慢的模型逐条打分，再按分数重新排序，只把前几条交给大模型。"],
        ["h", "为什么需要两阶段"],
        ["p", "召回面对百万级文档，必须用双塔 + ANN 这类可离线计算的方法保证速度；但双塔只比较两个独立向量，精度有限。重排只处理少量候选，可以用交叉编码器让查询和文档充分交互，换取更高的精度。"],
        ["h", "常用做法"],
        ["ul", ["模型：bge-reranker、ms-marco-MiniLM 等交叉编码器", "输入长度控制在 512 token 内，长文档先切块再打分", "召回 100 条，重排后取前 5–10 条"]]
      ],
      "交叉编码器": [
        ["p", "交叉编码器（Cross-Encoder）把查询和文档拼接成一个序列，一起送入 Transformer 编码，最后由分类头直接输出相关性分数。因为注意力可以在查询和文档的每个词之间计算，它能捕捉细粒度的匹配关系，精度明显高于双塔模型。"],
        ["code", "[CLS] 查询 [SEP] 文档 [SEP]  →  Transformer  →  相关性分数\n\nscores = model.predict([(query, doc) for doc in candidates])"],
        ["h", "为什么不能用来召回"],
        ["p", "每一对（查询，文档）都要完整前向计算一次，文档表示无法离线预先算好。面对百万级文档时，延迟不可接受，所以它只用于对少量候选做重排。"],
        ["h", "与双塔模型对比"],
        ["ul", ["双塔：分别编码，可离线建索引，快但精度有限，用于召回", "交叉编码器：联合编码，不能离线，慢但精度高，用于重排"]],
        ["h", "常用模型"],
        ["p", "bge-reranker、ms-marco-MiniLM-L-6-v2。（此段为你手动补充）"]
      ],
      "双塔模型": [
        ["p", "双塔模型（Bi-Encoder）用两个编码器分别把查询和文档编码成向量，用向量相似度衡量相关性。文档向量可以离线批量计算并写入向量索引，线上只需编码一次查询，再做近似最近邻检索，因此适合在海量文档中召回。"],
        ["h", "局限"],
        ["p", "查询和文档在编码阶段互不可见，细粒度的词级匹配信息会丢失，所以通常需要交叉编码器在后面做重排。"]
      ],
      "向量检索": [
        ["p", "向量检索把文本编码为稠密向量，按余弦相似度或内积找出与查询最接近的文档，擅长匹配语义相近但用词不同的表达。"],
        ["h", "规模化"],
        ["p", "暴力计算的复杂度是 O(N)，千万级向量时延迟过高，需要 ANN 索引（如 HNSW）以少量精度换取数量级的速度提升。"]
      ],
      "HNSW": [
        ["p", "HNSW（分层可导航小世界图）把向量组织成多层图：上层节点稀疏、连边跨度大，下层稠密。查询从最上层入口点开始贪心搜索，逐层下降，在底层用束搜索得到候选集。"],
        ["code", "def search(q, ef):\n    ep = entry_point\n    for layer in range(top, 0, -1):\n        ep = greedy(q, ep, layer)\n    return beam_search(q, ep, ef, layer=0)"],
        ["h", "关键参数"],
        ["ul", ["M：每个节点的邻居数，越大召回越高、内存越大", "efConstruction：建图时的搜索宽度，影响图质量", "efSearch：查询时的搜索宽度，权衡召回率与延迟"]]
      ]
    },
    completeness: {
      "交叉编码器": { covered: ["原理与输入格式", "为什么不适合召回", "与双塔模型的对比", "常用模型"], missing: ["训练方式：如何构造正负样本、损失函数", "推理延迟的量级（如 100 条候选约多少毫秒）", "与 ColBERT 等延迟交互模型的对比"] },
      "RAG": { covered: ["定义与动机", "离线 / 在线流程", "检索质量的影响", "与微调的区别"], missing: ["文档切块策略（长度、重叠、按结构切分）", "Prompt 拼接与引用溯源", "效果评估方法（召回率、忠实度）"] }
    },
    entries: {
      "RAG": { category: "rag", kind: "concept", aliases: ["检索增强生成", "Retrieval-Augmented Generation"], updatedAt: "昨天 23:00",
        points: ["流程：切块 → 向量化入库 → 检索 → 重排 → 拼接上下文 → 生成", "解决大模型知识过时与幻觉问题，回答可溯源", "效果主要取决于检索质量：召回率与重排精度"],
        gaps: "生成阶段（Prompt 拼接、引用溯源、效果评估）和文档切块策略，你还没有相关学习记录。" },
      "混合检索": { category: "rag", kind: "method", aliases: ["Hybrid Search"], updatedAt: "周三 23:00",
        points: ["关键词检索擅长专有名词精确匹配，向量检索擅长语义相近表达", "两路分数先归一化，再加权或用 RRF 融合"] },
      "重排": { category: "rag", kind: "method", aliases: ["Rerank", "精排"], updatedAt: "昨天 23:00",
        points: ["对召回的几十到几百条候选做精细打分", "常用交叉编码器，精度高但只能处理少量候选", "召回追求高召回率，重排追求高精度"] },
      "交叉编码器": { category: "rag", kind: "model", aliases: ["Cross-Encoder"], updatedAt: "今天 14:30",
        points: ["输入：[CLS] query [SEP] doc，输出相关性分数", "无法离线预计算，不适合召回", "常用模型：bge-reranker、ms-marco-MiniLM"] },
      "双塔模型": { category: "rag", kind: "model", aliases: ["Bi-Encoder", "Dual Encoder"], updatedAt: "今天 14:30",
        points: ["查询与文档分别编码，文档向量离线计算", "线上只编码查询，配合 ANN 索引毫秒级召回"] },
      "向量检索": { category: "retrieval", kind: "method", aliases: ["Dense Retrieval", "语义检索"], updatedAt: "昨天 23:00",
        points: ["文本编码为向量，按余弦相似度或内积检索", "规模大时依赖 ANN 索引"] },
      "Embedding": { category: "retrieval", kind: "concept", aliases: ["嵌入", "向量表示"], updatedAt: "周三 23:00",
        points: ["把文本映射到稠密向量空间，语义相近的文本距离更近"] },
      "ANN": { category: "retrieval", kind: "concept", aliases: ["近似最近邻"], updatedAt: "周三 23:00",
        points: ["以少量精度换取数量级的速度提升", "常见索引：HNSW、IVF、PQ"] },
      "HNSW": { category: "retrieval", kind: "algorithm", aliases: ["分层可导航小世界图"], updatedAt: "周三 23:00",
        points: ["多层图，上层稀疏下层稠密，逐层贪心下降", "参数：M、efConstruction、efSearch"] },
      "BM25": { category: "retrieval", kind: "algorithm", aliases: ["Okapi BM25"], updatedAt: "周三 23:00",
        points: ["IDF 衡量词的区分度", "k1 控制词频饱和，b 控制文档长度归一化"] },
      "Transformer": { category: "model", kind: "paper", aliases: ["Attention Is All You Need"], updatedAt: "周二 23:00",
        points: ["完全基于注意力，摒弃循环与卷积", "Multi-Head Attention + 位置编码"] },
      "注意力机制": { category: "model", kind: "concept", aliases: ["Attention"], updatedAt: "周二 23:00",
        points: ["Scaled Dot-Product：softmax(QKᵀ/√dₖ)V", "除以 √dₖ 防止点积过大导致梯度消失"] }
    }
  },
  providers: [
    { id: "deepseek", name: "DeepSeek", logo: "DS", color: "#4d6bfe", baseUrl: "https://api.deepseek.com/v1", key: "sk-…9f2a", model: "deepseek-chat", status: "ok" },
    { id: "openai", name: "OpenAI 兼容", logo: "AI", color: "#10a37f", baseUrl: "https://api.openai.com/v1", key: "", model: "gpt-4o-mini", status: "none" },
    { id: "anthropic", name: "Anthropic", logo: "A", color: "#c96442", baseUrl: "https://api.anthropic.com", key: "", model: "claude-sonnet", status: "none" },
    { id: "ollama", name: "Ollama（本地）", logo: "OL", color: "#1f2329", baseUrl: "http://127.0.0.1:11434", key: "无需", model: "qwen2.5:7b", status: "ok" }
  ],
  /* Organize pipeline (see docs/tech-solution/07): rule steps have no model; LLM steps pick one each. */
  pipeline: [
    { step: "①", name: "上下文加载", en: "Context Loader", kind: "rule" },
    { step: "②", name: "片段切分", en: "Episode Builder", kind: "rule" },
    { step: "③", name: "学习判定", en: "Learning Judge", kind: "llm", task: "learning_judge" },
    { step: "④", name: "已有知识检索", en: "Knowledge Retriever", kind: "rule", task: "embedding" },
    { step: "⑤", name: "知识判定", en: "Knowledge Judge", kind: "llm", task: "knowledge_judge" },
    { step: "⑥", name: "知识抽取", en: "Knowledge Extraction", kind: "llm", task: "extraction" },
    { step: "⑦", name: "词条对齐", en: "Entry Alignment", kind: "rule" },
    { step: "⑧", name: "知识入库", en: "Knowledge Integration", kind: "llm", task: "entry_rewrite" },
    { step: "⑨", name: "整理记录", en: "Organize Run", kind: "rule" }
  ],
  tasks: [
    { id: "learning_judge", group: "organize", step: "③", name: "学习判定", en: "Learning Judge", desc: "判断一段活动是不是学习、学的是什么。只读行为摘要，不读正文，可用小模型", provider: "Ollama（本地）", model: "qwen2.5:7b" },
    { id: "knowledge_judge", group: "organize", step: "⑤", name: "知识判定", en: "Knowledge Judge", desc: "逐条判断内容是新知识、补充、重复还是不入库，读正文节选", provider: "DeepSeek", model: "deepseek-chat" },
    { id: "extraction", group: "organize", step: "⑥", name: "知识抽取", en: "Knowledge Extraction", desc: "从入库内容中抽取知识点、要点和关系，读全文", provider: "DeepSeek", model: "deepseek-chat" },
    { id: "entry_rewrite", group: "organize", step: "⑧", name: "词条正文重写", en: "Entry Rewrite", desc: "生成和更新知识库词条正文、完整度，以及词条对齐的批量确认", provider: "DeepSeek", model: "deepseek-chat" },
    { id: "chat", group: "other", name: "首页对话", en: "Chat", desc: "回答关于学习记录和知识库的提问", provider: "DeepSeek", model: "deepseek-chat" },
    { id: "embedding", group: "other", step: "④", name: "向量 Embedding", en: "Embedding", desc: "已有知识检索、去重和对话检索，建议本地模型", provider: "Ollama（本地）", model: "bge-m3" }
  ],
  /* Learner Profile: only a bonus signal for the two judges, never a reason to reject. */
  profile: {
    role: "产品经理",
    focus: [{ topic: "RAG 检索与重排", expires: "10月25日" }, { topic: "Agent 架构", expires: "11月1日" }]
  },
  usage: { todayTokens: 48200, limitTokens: 200000, calls: 37 },
  organize: {
    auto: true,
    schedule: { on: true, time: "23:00" },
    batch: { on: true, count: 10 },
    onCapture: { on: false },
    lastRun: "昨天 23:00", nextRun: "今天 23:00", pendingCount: 4
  },
  runs: [
    {
      id: "r3", at: "昨天 23:00", trigger: "定时", duration: "2 分 14 秒", items: 6,
      episodes: { learning: 2, notLearning: 1, deferred: 0 }, ingested: 4, rejected: 2, failed: 0,
      decisions: { new: 2, supplement: 1, duplicate: 1, reject: 1, notLearning: 1 },
      kb: "+3 知识点 · +5 关系 · 更新 1 个描述", tokens: 21400,
      steps: [["学习判定", 3, 2100], ["知识判定", 2, 6800], ["知识抽取", 3, 9300], ["词条正文重写", 4, 3200]]
    },
    {
      id: "r2", at: "周三 16:42", trigger: "攒够 10 条", duration: "4 分 02 秒", items: 10,
      episodes: { learning: 3, notLearning: 1, deferred: 1 }, ingested: 6, rejected: 2, failed: 1,
      decisions: { new: 4, supplement: 1, duplicate: 1, reject: 1, notLearning: 1 },
      kb: "+5 知识点 · +7 关系", tokens: 38900, error: "1 条超出模型上下文长度，已跳过；1 个片段仍在进行中，推迟到下一批",
      steps: [["学习判定", 5, 3400], ["知识判定", 3, 11200], ["知识抽取", 6, 18100], ["词条正文重写", 5, 6200]]
    },
    {
      id: "r1", at: "周三 09:15", trigger: "手动 · 已选", duration: "38 秒", items: 2,
      episodes: { learning: 0, notLearning: 0, deferred: 0 }, ingested: 2, rejected: 0, failed: 0,
      decisions: { new: 2, supplement: 0, duplicate: 0, reject: 0, notLearning: 0 },
      kb: "+2 知识点", tokens: 6100, skipped: "手动整理所选条目，跳过片段切分与学习判定",
      steps: [["知识判定", 1, 1900], ["知识抽取", 2, 3300], ["词条正文重写", 2, 900]]
    }
  ],
  trash: [],
  rules: [
    { kind: "域名", value: "github.com/pulls", note: "工作页面，不是学习" },
    { kind: "URL 前缀", value: "https://www.bilibili.com/", note: "娱乐" },
    { kind: "列表页规则", value: "/tag/*", note: "自定义" }
  ],
  builtinRules: ["知乎：仅问题 / 回答 / 专栏文章 / 想法 / 视频", "掘金：仅 /post/*", "CSDN：仅 /article/details/*", "博客园：仅 /p/* 与 /archive/*", "通用：首页、搜索页、tag / category / explore / hot / feed / 分页", "通用：链接占比 > 50%、无成段正文、≥ 5 张重复短卡片"]
};
