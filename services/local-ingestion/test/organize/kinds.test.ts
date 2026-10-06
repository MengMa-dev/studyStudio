import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { integrateFragments, type ResultRecord } from "../../src/domains/organize/integrate";
import { resolveKind } from "../../src/domains/organize/kinds";
import { loadItems } from "../../src/domains/organize/store";
import { createEnv, insertEntry, insertItem, type TestEnv } from "./helpers";

test("resolveKind: legacy codes, normalization, non-seed falls back to 其他", () => {
  assert.equal(resolveKind(null), "其他");
  assert.equal(resolveKind("  "), "其他");
  assert.equal(resolveKind("tool"), "工具/资源");
  assert.equal(resolveKind("Library"), "工具/资源");
  assert.equal(resolveKind("设计模式"), "技巧");
  assert.equal(resolveKind("概念 "), "概念");
  assert.equal(resolveKind("数据集"), "其他");
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

test("migration 007 maps old Chinese seeds onto general kinds", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  const insert = env.db.prepare("INSERT INTO kb_entries(id, name, kind) VALUES (?, ?, ?)");
  ["算法", "论文", "库与框架", "最佳实践", "概念", "评测指标"].forEach((kind, i) => insert.run(`e${i}`, `E${i}`, kind));
  env.db.exec(readFileSync(new URL("../../src/migrations/007_kb_kinds_general.sql", import.meta.url), "utf8"));
  const kinds = (env.db.prepare("SELECT kind FROM kb_entries ORDER BY id").all() as Array<{ kind: string }>).map((row) => row.kind);
  assert.deepEqual(kinds, ["方法", "工具/资源", "工具/资源", "技巧", "概念", "评测指标"]);
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

function newEntry(name: string, kind: string) {
  return { key: `new:${name}`, name, aliases: [], kind, category: "测试", summary: `${name} 摘要` };
}

function integrate(env: TestEnv, entries: ReturnType<typeof newEntry>[], similarities: Array<[string, string, number]> = []) {
  insertItem(env.db, { id: "item_1", title: "条目", capturedAt: "2026-10-01T00:00:00.000Z", markdown: "正文" });
  const nameSimilarities = new Map<string, Array<{ entry_id: string; similarity: number }>>();
  for (const [name, entryId, similarity] of similarities) nameSimilarities.set(name, [{ entry_id: entryId, similarity }]);
  const fragments = entries.map((entry, index) => ({
    id: `f${index + 1}`,
    concept: entry.name,
    heading: "定义",
    markdown: entry.name,
    summarized: false,
    turn_item_id: null,
    entry: entry.key,
    covered_by: null
  }));
  return integrateFragments(
    { db: env.db, runId: "run_1", now: "2026-10-02T00:00:00.000Z", kbIgnore: [], nameSimilarities, usedNoteIds: [] },
    [...loadItems(env.db, ["item_1"]).values()],
    { decision: "new", fragments, new_entries: entries, relations: [], item_summary: "", item_points: [] },
    RECORD
  );
}

const kindOf = (env: TestEnv, name: string) => (env.db.prepare("SELECT kind FROM kb_entries WHERE name = ?").get(name) as { kind: string }).kind;

test("integrate: model-proposed custom kinds fall back to 其他, legacy codes map", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  integrate(env, [newEntry("BLEU", "评测指标"), newEntry("ImageNet", "数据集"), newEntry("Vite", "tool")]);
  assert.equal(kindOf(env, "BLEU"), "其他");
  assert.equal(kindOf(env, "ImageNet"), "其他");
  assert.equal(kindOf(env, "Vite"), "工具/资源");
});

test("integrate: alignment compares the resolved kind", (t) => {
  const env = createEnv();
  t.after(() => env.app.close());
  insertEntry(env.db, { id: "kb_hitl", name: "Human-in-the-loop", kind: "概念", body: "## 定义\n人工审批" });
  const result = integrate(env, [newEntry("人工介入", "concept")], [["人工介入", "kb_hitl", 0.95]]);
  assert.deepEqual(
    result.entryChanges.map((change) => [change.entryId, change.change]),
    [["kb_hitl", "supplemented"]]
  );
});
