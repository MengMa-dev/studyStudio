/**
 * C6 chat evaluation: runs the question set against a snapshot of the real data directory.
 * The snapshot (VACUUM INTO + secrets.json) lives in a temp dir, so chat history and the learner
 * profile of the real data are never touched; the scheduler is disabled so no organize run starts.
 * Usage: npm run verify:chat [-- --model=ollama/qwen2.5:7b] [--only=1,5,12] [--keep]
 *   --model  override the `chat` task model (provider/model); default: configured chat → knowledge_processing
 *   --keep   keep the snapshot dir for inspection
 * Reads STUDY_STUDIO_DATA_DIR (default ./StudyStudioData). Writes tmp/chat-eval-<label>.json.
 */
import { request } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_CITATION_MARKER, citationMarkerNumbers, type ChatCitationsData, type ChatContext } from "@study-studio/shared";
import { createIngestionServer } from "../../services/local-ingestion/src/create-server.js";

const root = resolve(import.meta.dirname, "../..");
const sourceDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelOverride = arg("model");
const only = arg("only")?.split(",").map(Number);
const keep = process.argv.includes("--keep");

type Expect = "cited" | "no_hit" | "organize" | "profile" | "any";
type Question = { text: string; context: ChatContext; expect: Expect; organizeOptions?: number };

function snapshot(): string {
  const dir = mkdtempSync(join(tmpdir(), "study-studio-chat-eval-"));
  const source = new DatabaseSync(join(sourceDir, "studystudio.db"), { readOnly: true });
  source.exec(`VACUUM INTO '${join(dir, "studystudio.db").replaceAll("'", "''")}'`);
  source.close();
  for (const file of ["secrets.json", ".pairing-token"]) if (existsSync(join(sourceDir, file))) copyFileSync(join(sourceDir, file), join(dir, file));
  const db = new DatabaseSync(join(dir, "studystudio.db"));
  db.exec("DELETE FROM chat_messages");
  db.close();
  return dir;
}

function pickTargets(dir: string) {
  const db = new DatabaseSync(join(dir, "studystudio.db"), { readOnly: true });
  const entry = db.prepare("SELECT id, name FROM kb_entries WHERE deleted_at IS NULL ORDER BY length(body_markdown) DESC LIMIT 1").get() as
    { id: string; name: string } | undefined;
  const item = db
    .prepare(
      `SELECT i.id, i.title FROM items i JOIN item_contents c ON c.item_id = i.id
       WHERE i.deleted_at IS NULL AND i.type = 'webpage' ORDER BY length(c.markdown) DESC LIMIT 1`
    )
    .get() as { id: string; title: string } | undefined;
  const entries = db.prepare("SELECT name FROM kb_entries WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5").all() as { name: string }[];
  db.close();
  return { entry, item, entries: entries.map((row) => row.name) };
}

function questions(targets: ReturnType<typeof pickTargets>): Question[] {
  const home: ChatContext = { page: "home" };
  const [e1 = "RAG", e2 = "向量检索", e3 = "重排"] = targets.entries;
  const list: Question[] = [
    { text: "我今天学了什么", context: home, expect: "cited" },
    { text: "最近一周学了哪些", context: home, expect: "cited" },
    { text: "昨天学了什么", context: home, expect: "any" },
    { text: "这周我在 AI 编程工具上花了多少时间", context: home, expect: "any" },
    { text: `${e1} 是什么`, context: home, expect: "cited" },
    { text: `${e2} 到底讲了什么`, context: home, expect: "cited" },
    { text: `我学过的 ${e3} 有哪些要点`, context: home, expect: "cited" },
    { text: "我哪些知识掌握得不好", context: home, expect: "any" },
    { text: "我掌握得比较好的知识有哪些", context: home, expect: "any" },
    { text: "什么是 k8s", context: home, expect: "no_hit" },
    { text: "Rust 的所有权机制是什么", context: home, expect: "no_hit" },
    { text: "我是前端开发", context: home, expect: "profile" },
    { text: "我最近在学 Agent 架构", context: home, expect: "profile" },
    { text: "整理", context: { page: "inbox" }, expect: "organize", organizeOptions: 2 },
    { text: "整理", context: { page: "progress" }, expect: "organize", organizeOptions: 2 }
  ];
  if (targets.entry) {
    const context: ChatContext = { page: "entry", entryId: targets.entry.id };
    list.push(
      { text: "这个知识点讲解是否完整", context, expect: "cited" },
      { text: "它和哪些知识点有关", context, expect: "any" },
      { text: "整理", context, expect: "organize", organizeOptions: 3 }
    );
  }
  if (targets.item) {
    const context: ChatContext = { page: "item", itemId: targets.item.id };
    list.push({ text: "这篇文章讲了什么", context, expect: "cited" }, { text: "帮我整理该页知识点", context, expect: "organize", organizeOptions: 1 });
  }
  return list;
}

type Chunk = { type: string; [key: string]: unknown };

/** node:http instead of fetch: undici aborts bodies idle for 5 min, which slow local models exceed. */
function post(port: number, path: string, token: string, body: string): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolvePost, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolvePost({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function parseSse(text: string): Chunk[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Chunk);
}

async function main() {
  const dir = snapshot();
  const targets = pickTargets(dir);
  const token = "chat-eval";
  const ingestion = await createIngestionServer({ dataDir: dir, pairingToken: token, disableScheduler: true, disableBackgroundIndex: true });
  if (modelOverride) {
    const [providerId, ...rest] = modelOverride.split("/");
    ingestion.aiConfig.setTaskModel({ task: "chat", providerId: providerId!, model: rest.join("/"), fallbackProviderId: null, fallbackModel: null });
  }
  const port = await ingestion.listen(0);
  const db = ingestion.db.db;
  const exists = (kind: string, id: string) => {
    if (kind === "entry") return Boolean(db.prepare("SELECT 1 FROM kb_entries WHERE id = ?").get(id));
    if (kind === "item") return Boolean(db.prepare("SELECT 1 FROM items WHERE id = ?").get(id));
    return /^\d{4}-\d{2}-\d{2}$/.test(id);
  };

  const all = questions(targets);
  const results = [];
  let seq = 0;
  for (const [index, q] of all.entries()) {
    if (only && !only.includes(index + 1)) continue;
    seq += 1;
    const started = Date.now();
    const response = await post(
      port,
      "/v1/chat",
      token,
      JSON.stringify({ message: { id: `eval-${seq}`, role: "user", parts: [{ type: "text", text: q.text }] }, context: q.context })
    );
    const raw = response.text;
    const chunks = response.ok ? parseSse(raw) : [];
    const text = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta as string)
      .join("");
    const tools = chunks.filter((chunk) => chunk.type === "tool-input-available").map((chunk) => `${chunk.toolName as string}(${JSON.stringify(chunk.input)})`);
    const citations = (chunks.find((chunk) => chunk.type === "data-citations")?.data as ChatCitationsData | undefined) ?? { citations: [], nonRecord: true };
    const organize = chunks.find((chunk) => chunk.type === "data-organize-card")?.data as { options: unknown[] } | undefined;
    const profile = chunks.find((chunk) => chunk.type === "data-profile-card");
    const errors = chunks.filter((chunk) => chunk.type === "error").map((chunk) => chunk.errorText as string);
    if (!response.ok) errors.push(`${response.status} ${raw}`);

    const problems: string[] = [...errors];
    const invalid = citations.citations.filter((c) => !exists(c.kind, c.id));
    if (invalid.length) problems.push(`invalid citations: ${invalid.map((c) => `${c.kind}:${c.id}`).join(",")}`);
    const markers = [...text.matchAll(CHAT_CITATION_MARKER)].flatMap((m) => citationMarkerNumbers(m[1]!));
    const dangling = markers.filter((n) => !citations.citations.some((c) => c.n === n));
    if (dangling.length) problems.push(`unregistered markers: ${[...new Set(dangling)].join(",")}`);
    if (q.expect === "cited" && citations.citations.length === 0) problems.push("expected citations");
    if (q.expect === "no_hit" && !/知识库没有相关内容/.test(text)) problems.push("no-hit answer missing 「知识库没有相关内容」");
    if (q.expect === "organize" && !organize) problems.push("expected organize card");
    if (q.expect === "organize" && organize && q.organizeOptions && organize.options.length !== q.organizeOptions)
      problems.push(`expected ${q.organizeOptions} organize options, got ${organize.options.length}`);
    if (q.expect === "profile" && !profile) problems.push("expected profile card");
    if (q.expect === "organize" && /已开始整理|正在整理/.test(text)) problems.push("claims organize started");

    const result = {
      n: index + 1,
      question: q.text,
      page: q.context.page,
      expect: q.expect,
      ok: problems.length === 0,
      problems,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      tools,
      citations: citations.citations.map((c) => `[${c.n}] ${c.kind}:${c.title}`),
      nonRecord: citations.nonRecord,
      text
    };
    results.push(result);
    console.log(
      `${result.ok ? "✔" : "✘"} #${result.n} [${q.context.page}] ${q.text} (${result.seconds}s) tools=${tools.length} cites=${citations.citations.length}`
    );
    for (const problem of problems) console.log(`    - ${problem}`);
  }

  const model = (db.prepare("SELECT model FROM chat_messages WHERE role = 'assistant' AND model IS NOT NULL LIMIT 1").get() as { model?: string } | undefined)
    ?.model;
  const label = (modelOverride ?? model ?? "default").replaceAll(/[^\w.-]+/g, "_");
  mkdirSync(join(root, "tmp"), { recursive: true });
  const out = join(root, "tmp", `chat-eval-${label}.json`);
  writeFileSync(out, JSON.stringify({ model: model ?? null, targets, results }, null, 2));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed · model ${model ?? "-"} · report ${out}`);

  await ingestion.close();
  if (keep) console.log(`snapshot kept at ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

await main();
