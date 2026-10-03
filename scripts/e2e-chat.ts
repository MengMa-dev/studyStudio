/**
 * C6 end-to-end: built workbench + local service (mock model) in Playwright Chromium.
 * 1. Home: ask a knowledge question → streamed answer with [n] → basis link opens the entry.
 * 2. Item page: floating chat → 「帮我整理该页知识点」 → confirm card → organize run starts.
 * Usage: npm run e2e:chat [-- --headed] [--build]   (--build rebuilds apps/workbench/dist first)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createIngestionServer } from "../services/local-ingestion/src/create-server.js";
import { createLoginLink } from "../services/local-ingestion/src/http/app.js";
import { ENTRY_OWNER } from "../services/local-ingestion/src/domains/organize/runtime-types.js";
import { localDay } from "../services/local-ingestion/src/domains/timeline/time.js";

const root = process.cwd();
const headed = process.argv.includes("--headed") || process.env.HEADED === "1";
const dist = join(root, "apps/workbench/dist");
if (process.argv.includes("--build") || !existsSync(join(dist, "index.html"))) {
  execFileSync("npm", ["run", "build", "-w", "@study-studio/workbench"], { stdio: "inherit" });
}

const dataDir = mkdtempSync(join(tmpdir(), "study-studio-e2e-chat-"));
const ingestion = await createIngestionServer({
  dataDir,
  pairingToken: "e2e-chat",
  disableScheduler: true,
  disableBackgroundIndex: true,
  skipVector: true,
  workbenchDist: dist
});
const browser = await chromium.launch({ channel: "chromium", headless: !headed });

async function step(name: string, run: () => Promise<void>) {
  process.stdout.write(`• ${name} … `);
  await run();
  console.log("ok");
}

async function ask(page: Page, scope: string, text: string) {
  const input = page.locator(scope).getByLabel("对话输入");
  await input.fill(text);
  await input.press("Enter");
}

try {
  ingestion.aiConfig.insertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: "deterministic" });
  for (const task of ["chat", "learning_judge", "knowledge_processing", "entry_rewrite"] as const) {
    ingestion.aiConfig.setTaskModel({ task, providerId: "mock", model: "deterministic", fallbackProviderId: null, fallbackModel: null });
  }
  const db = ingestion.db.db;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO kb_entries (id, name, kind, aliases, summary, body_markdown, mastery, mastery_source, user_edited, stale, orphan, patch_count, dirty, updated_at)
     VALUES ('kb-rag', 'RAG', 'concept', '[]', 'RAG 是检索增强生成', '## 定义\n\nRAG 先检索再生成。', 0.3, 'auto', 0, 0, 0, 0, 0, ?)`
  ).run(now);
  await ingestion.searchIndex.indexDocument({ ownerType: ENTRY_OWNER.summary, ownerId: "kb-rag", text: "RAG 是检索增强生成" });
  db.prepare(
    "INSERT INTO items (id, type, title, url, site, captured_at) VALUES ('i1', 'webpage', 'RAG 入门', 'https://example.com/i1', 'example.com', ?)"
  ).run(now);
  db.prepare("INSERT INTO item_contents (item_id, markdown) VALUES ('i1', ?)").run("# RAG 入门\n\n检索增强生成先召回文档，再让模型基于文档回答。");
  db.prepare("INSERT INTO events (id, type, occurred_at, day, item_id, payload, received_at) VALUES ('ev-1', 'reading_session_closed', ?, ?, 'i1', ?, ?)").run(
    now,
    localDay(now),
    JSON.stringify({ countedSeconds: 600, openedAt: now }),
    now
  );

  const port = await ingestion.listen(0);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  await page.goto(createLoginLink(ingestion.auth, port));
  await page.waitForURL(/#\/home/);

  await step("首页提问 → 流式回答带引用 → 依据跳转词条", async () => {
    await ask(page, "main", "RAG 是什么");
    const basis = page.getByLabel("依据").last();
    await basis.getByRole("link", { name: /RAG/ }).waitFor({ timeout: 20_000 });
    await page.locator(".chat-cite a:visible").first().waitFor();
    await basis.getByRole("link", { name: /RAG/ }).click();
    await page.waitForURL(/#\/wiki\/kb-rag/);
  });

  await step("条目详情悬浮对话 → 整理确认卡片 → 开始整理", async () => {
    await page.goto(`http://127.0.0.1:${port}/app/#/item/i1`);
    await page.getByRole("button", { name: "打开对话" }).click();
    const dock = page.getByLabel("悬浮对话");
    await dock.getByText("RAG 是什么").first().waitFor();
    await ask(page, "aside.dock-panel", "帮我整理该页知识点");
    const card = dock.getByLabel("整理确认").last();
    await card.getByRole("button", { name: "确认整理" }).click();
    await card.getByText("已开始整理").waitFor({ timeout: 10_000 });
    const run = db.prepare("SELECT trigger FROM organize_runs ORDER BY rowid DESC LIMIT 1").get() as { trigger: string } | undefined;
    if (run?.trigger !== "manual") throw new Error(`expected a manual organize run, got ${JSON.stringify(run)}`);
  });

  await step("点击面板外收起，首页保留同一会话", async () => {
    await page.mouse.click(200, 400);
    await page.getByRole("button", { name: "打开对话" }).waitFor();
    await page.goto(`http://127.0.0.1:${port}/app/#/home`);
    await page.getByText("帮我整理该页知识点").first().waitFor();
  });
  console.log("e2e:chat passed");
} finally {
  await browser.close();
  await ingestion.close();
  rmSync(dataDir, { recursive: true, force: true });
}
