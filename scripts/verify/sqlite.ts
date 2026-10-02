/**
 * M0 verification: node:sqlite + FTS5 (Segmenter-presegmented unicode61, trigram) + sqlite-vec via loadExtension.
 * Usage: npm run verify:sqlite
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

export type CheckResult = { name: string; ok: boolean; detail: string };

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
/** Space-joined word segments, so unicode61 can index Chinese words. */
export const segment = (text: string) =>
  [...segmenter.segment(text.toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .join(" ");

const matchQuery = (text: string) => `"${segment(text).replaceAll('"', '""')}"`;

function run(name: string, fn: () => string): CheckResult {
  try {
    return { name, ok: true, detail: fn() };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const DOCS = [
  "交叉编码器用于重排阶段，对召回的候选文档精排",
  "LangGraph 的 interrupt() 依赖 checkpoint 持久化实现 human-in-the-loop",
  "向量召回使用 embedding 相似度从大规模语料中粗筛"
];

export function verifySqlite(): CheckResult[] {
  const results: CheckResult[] = [];
  const dir = mkdtempSync(join(tmpdir(), "study-studio-sqlite-"));
  const db = new DatabaseSync(join(dir, "verify.db"), { allowExtension: true });
  try {
    results.push(
      run("sqlite version, WAL, quick_check", () => {
        const { version } = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
        const { journal_mode } = db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
        const { quick_check } = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
        assert(journal_mode === "wal" && quick_check === "ok", `journal_mode=${journal_mode}, quick_check=${quick_check}`);
        return `SQLite ${version}, journal_mode=${journal_mode}`;
      })
    );

    results.push(
      run("FTS5 unicode61 + Intl.Segmenter presegmentation", () => {
        db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(seg_text, tokenize='unicode61')");
        const insert = db.prepare("INSERT INTO docs_fts(rowid, seg_text) VALUES (?, ?)");
        DOCS.forEach((text, index) => insert.run(index + 1, segment(text)));
        const search = db.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts)");
        const hits = (query: string) => (search.all(matchQuery(query)) as { rowid: number }[]).map((row) => row.rowid);
        assert(hits("重排").join() === "1", `重排 → ${hits("重排").join() || "none"}`);
        assert(hits("交叉编码器").join() === "1", `交叉编码器 → ${hits("交叉编码器").join() || "none"}`);
        assert(hits("checkpoint").join() === "2", `checkpoint → ${hits("checkpoint").join() || "none"}`);
        assert(hits("召回").sort().join() === "1,3", `召回 → ${hits("召回").join() || "none"}`);
        return `segments: ${segment(DOCS[0]!)}`;
      })
    );

    results.push(
      run("FTS5 trigram (substring, LIKE fallback for < 3 chars)", () => {
        db.exec("CREATE VIRTUAL TABLE docs_tri USING fts5(text, tokenize='trigram')");
        const insert = db.prepare("INSERT INTO docs_tri(rowid, text) VALUES (?, ?)");
        DOCS.forEach((text, index) => insert.run(index + 1, text));
        const match = db.prepare("SELECT rowid FROM docs_tri WHERE docs_tri MATCH ?").all('"编码器"') as { rowid: number }[];
        assert(match.map((row) => row.rowid).join() === "1", "trigram MATCH 编码器 failed");
        const like = db.prepare("SELECT rowid FROM docs_tri WHERE text LIKE ?").all("%精排%") as { rowid: number }[];
        assert(like.map((row) => row.rowid).join() === "1", "LIKE 精排 failed");
        return "MATCH 编码器 → 1, LIKE %精排% → 1";
      })
    );

    results.push(
      run("sqlite-vec loadExtension + vec0 KNN", () => {
        db.loadExtension(getLoadablePath());
        const { version } = db.prepare("SELECT vec_version() AS version").get() as { version: string };
        db.exec("CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[4])");
        const insert = db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)");
        const vectors: [number, number[]][] = [
          [1, [1, 0, 0, 0]],
          [2, [0.9, 0.1, 0, 0]],
          [3, [0, 0, 1, 0]]
        ];
        for (const [rowid, vector] of vectors) insert.run(BigInt(rowid), new Float32Array(vector));
        const rows = db
          .prepare("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 2 ORDER BY distance")
          .all(new Float32Array([1, 0.05, 0, 0])) as { rowid: number; distance: number }[];
        assert(rows.map((row) => row.rowid).join() === "1,2", `KNN → ${rows.map((row) => row.rowid).join()}`);
        db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(1n);
        const after = db.prepare("SELECT rowid FROM chunks_vec WHERE embedding MATCH ? AND k = 1").all(new Float32Array([1, 0, 0, 0])) as { rowid: number }[];
        assert(after[0]?.rowid === 2, "delete not reflected in KNN");
        return `sqlite-vec ${version}, KNN top-2 = ${rows.map((row) => `${row.rowid}(${row.distance.toFixed(3)})`).join(", ")}`;
      })
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const results = verifySqlite();
  for (const { name, ok, detail } of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}
