import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_TOKENS, chunkUnit } from "../../src/domains/organize/chunk.js";
import type { WorkUnit } from "../../src/domains/organize/process.js";
import type { OrganizeItem } from "../../src/domains/organize/store.js";
import { estimateTokens } from "../../src/search/chunk.js";

function item(partial: Partial<OrganizeItem>): OrganizeItem {
  return {
    id: "item_1",
    type: "document",
    title: "Doc",
    url: null,
    question: null,
    conversationId: null,
    capturedAt: "2026-10-02T12:00:00Z",
    status: "pending",
    dirty: false,
    contentHash: null,
    body: "",
    highlights: [],
    itemNotes: [],
    exposure: [],
    ...partial
  } as OrganizeItem;
}

function unit(items: OrganizeItem[]): WorkUnit {
  return { key: items[0]!.id, items, episode: null, engagement: "strong", adopt: false, path: "direct" };
}

const strip = (text: string) => text.replace(/\s+/g, "");

function paragraphs(label: string, tokens: number): string {
  const sentence = `${label} 的机制说明，包含原理与限制。`;
  const lines: string[] = [];
  for (let used = 0; used < tokens; used += estimateTokens(sentence) * 10) lines.push(Array(10).fill(sentence).join(""));
  return lines.join("\n\n");
}

test("short body → single chunk with full text", () => {
  const chunks = chunkUnit(unit([item({ body: "# 标题\n\n一段正文。" })]));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.index, 0);
  assert.equal(chunks[0]!.total, 1);
  assert.ok(chunks[0]!.text?.includes("一段正文"));
  assert.equal(chunks[0]!.turns, null);
});

test("long body → multiple bounded chunks, heading paths, no lost text", () => {
  const body = [
    "# Transformer",
    "## Self-Attention",
    paragraphs("注意力", 4000),
    "## Positional Encoding",
    "```bash\n# not a heading\necho hi\n```",
    paragraphs("位置编码", 4000),
    "### Sinusoidal",
    paragraphs("正弦", 4000)
  ].join("\n\n");
  const chunks = chunkUnit(unit([item({ body })]));
  assert.ok(chunks.length >= 2, `got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.equal(chunk.total, chunks.length);
    assert.ok(estimateTokens(chunk.text!) <= CHUNK_TOKENS * 1.4, `chunk ${chunk.index} too large`);
  }
  assert.equal(strip(chunks.map((chunk) => chunk.text).join("")), strip(body));
  assert.deepEqual(chunks[0]!.heading_path, []);
  const last = chunks[chunks.length - 1]!;
  assert.ok(last.heading_path.includes("# Transformer"));
  assert.ok(!chunks.some((chunk) => chunk.heading_path.includes("# not a heading")));
  const sinusoidal = chunks.find((chunk) => chunk.index > 0 && chunk.heading_path.includes("### Sinusoidal"));
  if (sinusoidal) assert.ok(sinusoidal.heading_path.includes("## Positional Encoding"));
});

test("conversation thread → turns packed whole with context question", () => {
  const answer = paragraphs("回答", 2500);
  const turns = [1, 2, 3, 4, 5].map((n) =>
    item({ id: `turn_${n}`, type: "conversation", conversationId: "c1", question: `问题 ${n}`, title: `问题 ${n}`, body: answer })
  );
  const chunks = chunkUnit(unit(turns));
  assert.ok(chunks.length >= 2);
  const flat = chunks.flatMap((chunk) => chunk.turns!);
  assert.deepEqual(
    flat.map((turn) => turn.turn_item_id),
    turns.map((turn) => turn.id)
  );
  assert.deepEqual(
    flat.map((turn) => turn.turn_index),
    [1, 2, 3, 4, 5]
  );
  for (const turn of flat) assert.equal(turn.answer, answer);
  assert.equal(chunks[0]!.context_question, null);
  const second = chunks[1]!;
  const previous = chunks[0]!.turns!;
  assert.equal(second.context_question, previous[previous.length - 1]!.question);
  assert.equal(second.text, null);
});
