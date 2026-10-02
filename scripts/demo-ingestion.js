import { randomUUID } from "node:crypto";

const port = process.env.STUDY_STUDIO_PORT ?? "43118";
const token = process.env.STUDY_STUDIO_TOKEN;
if (!token) throw new Error("Set STUDY_STUDIO_TOKEN to the pairing token printed by `npm run ingestion`.");
const source = { channel: "desktop_browser", platform: "chatgpt", url: "https://chatgpt.com/c/demo", title: "RAG 学习", isStrongLearning: true };
const base = (type) => ({ id: randomUUID(), schemaVersion: 1, type, occurredAt: new Date().toISOString(), source });
const events = [
  { ...base("user_message_sent"), message: { role: "user", plainText: "向量召回和重排有什么区别？", markdown: "向量召回和重排有什么区别？" } },
  {
    ...base("assistant_response_completed"),
    answer: {
      plainText: "召回负责从大规模候选中快速筛选，重排负责对候选精排。",
      markdown: "召回负责从大规模候选中快速筛选，重排负责对候选精排。",
      sanitizedHtml: "<p>召回负责从大规模候选中快速筛选，重排负责对候选精排。</p>",
      blocks: [{ type: "markdown", text: "召回负责从大规模候选中快速筛选，重排负责对候选精排。" }]
    }
  },
  { ...base("user_note"), note: { text: "刚才理解了召回和重排的分工。" }, context: { activeSourceUrl: source.url } },
  {
    ...base("webpage_captured"),
    source: { channel: "browser_extension", url: "https://example.com/rag", title: "RAG 工程实践", isStrongLearning: false },
    reason: "threshold",
    readingSignals: { activeDurationSeconds: 95, maxScrollDepth: 0.52, interactionCount: 0, noteWritten: false },
    content: {
      title: "RAG 工程实践",
      canonicalUrl: "https://example.com/rag",
      markdown: "# RAG 工程实践\n\n正文示例。",
      plainText: "RAG 工程实践 正文示例。".repeat(20),
      sanitizedHtml: "<article><h1>RAG 工程实践</h1><p>正文示例。</p></article>",
      contentHash: "demo",
      media: []
    }
  }
];
for (const event of events) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(event)
  });
  console.log(event.type, response.status, await response.text());
}
