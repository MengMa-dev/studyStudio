/**
 * M0 verification: the WXT build bundles collector-runtime into the content script, which collects
 * the existing fixtures and reaches the local service through the background worker.
 * Usage: npm run verify:wxt [-- --headed] [--skip-build]
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createIngestionServer } from "../../services/local-ingestion/src/create-server.js";

const root = resolve(import.meta.dirname, "../..");
const extensionDir = join(root, "apps/browser-extension");
const outputDir = join(extensionDir, ".output/chrome-mv3");
const headed = process.argv.includes("--headed");
const token = "verify-token";

const fixtures: Record<string, string> = {
  "https://blog.example.com/posts/retrieval-reranking": "article.html",
  "https://github.com/example/rag-toolkit": "github-readme.html",
  "https://chatgpt.com/c/verify": "chatgpt.html"
};

type StoredEvent = { reason?: string; artifact?: string };

if (!process.argv.includes("--skip-build")) {
  const build = spawnSync("npx", ["wxt", "build"], { cwd: extensionDir, stdio: "inherit" });
  if (build.status !== 0) throw new Error("wxt build failed");
}

const dataDir = await mkdtemp(join(tmpdir(), "study-studio-verify-"));
const profileDir = await mkdtemp(join(tmpdir(), "study-studio-profile-"));
const ingestion = await createIngestionServer({ dataDir, pairingToken: token });
const port: number = await ingestion.listen(0);
let context: BrowserContext | null = null;

const debugPreset = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ captureRules: { preset: "debug" } })
});
if (!debugPreset.ok) throw new Error(`PUT /v1/settings failed: ${debugPreset.status}`);

const artifactDirs: Record<string, string> = { webpage_captured: "inbox/webpages/page-", assistant_response_completed: "inbox/conversations/qa-" };

function storedEvent(type: string, url: string): StoredEvent | undefined {
  const row = ingestion.db.db.prepare("SELECT payload, item_id FROM events WHERE type = ? AND url = ? ORDER BY received_at DESC LIMIT 1").get(type, url) as
    { payload: string; item_id: string | null } | undefined;
  if (!row) return undefined;
  const prefix = artifactDirs[type];
  return { ...(JSON.parse(row.payload) as { reason?: string }), artifact: prefix && row.item_id ? `${prefix}${row.item_id}` : undefined };
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const findEntry = (type: string, url: string) => async () => storedEvent(type, url);

const checks: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, run: () => Promise<string>) {
  try {
    checks.push({ name, ok: true, detail: await run() });
  } catch (error) {
    checks.push({ name, ok: false, detail: (error as Error).message });
  }
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    args: [`--disable-extensions-except=${outputDir}`, `--load-extension=${outputDir}`]
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url().split("?")[0]!;
    const name = fixtures[url];
    if (name) return route.fulfill({ contentType: "text/html", body: await readFile(join(root, "tests/fixtures", name), "utf8") });
    if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
    return route.fulfill({ status: 204, body: "" });
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  type Hooks = {
    __studyStudio?: {
      saveConnection(url: string, token: string): Promise<{ connectivity?: { state?: string } }>;
      setCollecting(collecting: boolean): Promise<unknown>;
    };
  };
  await waitFor("extension test hooks", () => worker.evaluate(() => Boolean((globalThis as Hooks).__studyStudio)));
  await worker.evaluate(() => (globalThis as Hooks).__studyStudio!.setCollecting(true));
  const connected = await worker.evaluate(([ingestionUrl, pairingToken]) => (globalThis as Hooks).__studyStudio!.saveConnection(ingestionUrl, pairingToken), [
    `http://127.0.0.1:${port}`,
    token
  ] as const);
  if (JSON.stringify(connected).includes('"offline"') || JSON.stringify(connected).includes('"unauthorized"')) {
    throw new Error(`extension could not connect: ${JSON.stringify(connected)}`);
  }

  const open = async (url: string): Promise<Page> => {
    const page = await context!.newPage();
    await page.goto(url);
    return page;
  };

  await check("article: capture through background → service", async () => {
    const url = "https://blog.example.com/posts/retrieval-reranking";
    const page = await open(url);
    await page.evaluate(() => document.dispatchEvent(new Event("copy")));
    const entry = await waitFor("webpage_captured", findEntry("webpage_captured", url));
    const markdown = await readFile(join(dataDir, entry.artifact!, "content.md"), "utf8");
    if (!/```js\nconst candidates = await index\.search/.test(markdown)) throw new Error("code block missing from captured markdown");
    return `reason=${entry.reason}, ${markdown.length} chars of markdown`;
  });

  await check("GitHub: site adapter runs inside the WXT bundle", async () => {
    const url = "https://github.com/example/rag-toolkit";
    const page = await open(url);
    await page.evaluate(() => document.dispatchEvent(new Event("copy")));
    const entry = await waitFor("webpage_captured", findEntry("webpage_captured", url));
    const metadata = JSON.parse(await readFile(join(dataDir, entry.artifact!, "metadata.json"), "utf8")) as { content: { extractor: string } };
    if (metadata.content.extractor !== "site:github") throw new Error(`extractor=${metadata.content.extractor}`);
    return `reason=${entry.reason}, extractor=${metadata.content.extractor}`;
  });

  await check("ChatGPT: question and completed answer", async () => {
    const url = "https://chatgpt.com/c/verify";
    const page = await open(url);
    await page.waitForTimeout(500);
    await page.fill("#prompt-textarea", "向量召回和重排有什么区别？");
    await page.press("#prompt-textarea", "Enter");
    await waitFor("user_message_sent", findEntry("user_message_sent", url));
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { appendTurn(text: string): void; stream(html: string): void; finish(): void } }).fixture;
      fixture.appendTurn("向量召回和重排有什么区别？");
      fixture.stream("<p><strong>召回</strong>负责粗筛，重排负责精排。</p>");
      fixture.finish();
    });
    const answer = await waitFor("assistant_response_completed", findEntry("assistant_response_completed", url));
    const markdown = await readFile(join(dataDir, answer.artifact!, "answer.md"), "utf8");
    return `answer: ${markdown.trim()}`;
  });

  if (checks.some((item) => !item.ok)) {
    const status = await worker.evaluate(() => (globalThis as { __studyStudio?: { status(): Promise<unknown> } }).__studyStudio?.status());
    const events = ingestion.db.db.prepare("SELECT type, url FROM events").all();
    console.log("extension status:", JSON.stringify(status));
    console.log("server events:", JSON.stringify(events));
  }
} finally {
  await context?.close();
  await ingestion.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(profileDir, { recursive: true, force: true });
}

for (const { name, ok, detail } of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
process.exit(checks.length > 0 && checks.every((item) => item.ok) ? 0 : 1);
