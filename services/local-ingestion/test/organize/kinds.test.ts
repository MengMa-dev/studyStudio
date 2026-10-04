import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEED_KINDS } from "@study-studio/shared";
import { integrateExtraction, type ResultRecord } from "../../src/domains/organize/integrate";
import { resolveKind } from "../../src/domains/organize/kinds";
import { loadItems } from "../../src/domains/organize/store";
import { createEnv, insertEntry, insertItem, type TestEnv } from "./helpers";

test("resolveKind: legacy codes, normalization, cap and length", () => {
  const vocab = [...SEED_KINDS, "评测指标"];
  assert.equal(resolveKind(null, vocab), "其他");
  assert.equal(resolveKind("  ", vocab), "其他");
  assert.equal(resolveKind("tool", vocab), "工具");
  assert.equal(resolveKind("Library", vocab), "库与框架");
  assert.equal(resolveKind("概念 ", vocab), "概念");
  assert.equal(resolveKind("ＲＡＧ技术", [...vocab, "rag技术"]), "rag技术");
  assert.equal(resolveKind("数据集", vocab), "数据集");
  const full = [...vocab, ...Array.from({ length: 20 - vocab.length }, (_, i) => `类型${i}`)];
  assert.equal(full.length, 20);
  assert.equal(resolveKind("数据集", full), "其他");
  assert.equal(resolveKind("评测指标", full), "评测指标");
  assert.equal(resolveKind("一个特别特别长的类型名", vocab), "其他");
});

test("migration 005 maps legacy codes and keeps Chinese names", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const insert = env.db.prepare("INSERT INTO kb_entries(id, name, kind) VALUES (?, ?, ?)");
  insert.run("a", "A", "concept");
  insert.run("b", "B", "library");
  insert.run("c", "C", null);
  insert.run("d", "D", "评测指标");
  env.db.exec(readFileSync(new URL("../../src/migrations/005_kb_kinds.sql", import.meta.url), "utf8"));
  const kinds = (env.db.prepare("SELECT id, kind FROM kb_entries ORDER BY id").all() as Array<{ kind: string }>).map((row) => row.kind);
  assert.deepEqual(kinds, ["概念", "库与框架", "其他", "评测指标"]);
});

const RECORD: ResultRecord = {
  decision: "new",
  route: "llm",
  valueScore: 0.9,
  rejectReason: null,
  reason: null,
  summary: null,
  points: null,
  model: null,
  promptVersion: null,
  inputHash: null,
  episodeId: null,
  override: null,
  output: null
};

function concept(name: string, kind: string) {
  return {
    name,
    match: "new",
    aliases: [],
    kind,
    evidence: [{ quote: name, question: null, turn_item_id: null }],
    patch: null,
    category: "测试",
    summary: `${name} 摘要`,
    body_markdown: `## 定义\n${name}`,
    completeness: null
  };
}

function integrate(env: TestEnv, concepts: ReturnType<typeof concept>[], similarities: Array<[string, string, number]> = []) {
  insertItem(env.db, { id: "item_1", title: "条目", capturedAt: "2026-10-01T00:00:00.000Z", markdown: "正文" });
  const nameSimilarities = new Map<string, Array<{ entry_id: string; similarity: number }>>();
  for (const [name, entryId, similarity] of similarities) nameSimilarities.set(name, [{ entry_id: entryId, similarity }]);
  return integrateExtraction(
    { db: env.db, runId: "run_1", now: "2026-10-02T00:00:00.000Z", kbIgnore: [], nameSimilarities, usedNoteIds: [] },
    [...loadItems(env.db, ["item_1"]).values()],
    { item_id: "item_1", value_score: 0.9, reason: "", decision: "new", item_summary: "", item_points: [], concepts, relations: [] },
    RECORD
  );
}

const kindOf = (env: TestEnv, name: string) => (env.db.prepare("SELECT kind FROM kb_entries WHERE name = ?").get(name) as { kind: string }).kind;

test("integrate: new kinds are created until the cap, legacy codes map", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  for (let i = 0; i < 9; i += 1) insertEntry(env.db, { id: `kb_${i}`, name: `已有${i}`, kind: `自建${i}`, body: "x" });
  integrate(env, [concept("BLEU", "评测指标"), concept("ImageNet", "数据集"), concept("Vite", "tool")]);
  assert.equal(kindOf(env, "BLEU"), "评测指标");
  assert.equal(kindOf(env, "ImageNet"), "其他");
  assert.equal(kindOf(env, "Vite"), "工具");
});

test("integrate: alignment compares the resolved kind", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", kind: "概念", body: "## 定义\n人工审批" });
  const result = integrate(env, [concept("人工介入", "concept")], [["人工介入", "kb_hitl", 0.95]]);
  assert.deepEqual(
    result.entryChanges.map((change) => [change.entryId, change.change]),
    [["kb_hitl", "supplemented"]]
  );
});
