/**
 * M2 extension e2e against the local stub server (not the real ingestion service yet).
 * Covers: offline queue → sync, manual sync, 422 failed display, activity events without body.
 * Usage: npx tsx scripts/e2e-extension.js [--headed] [--skip-build]
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createStubServer } from "../apps/browser-extension/test/stub-server.ts";

const root = resolve(import.meta.dirname, "..");
const extensionSrc = join(root, "apps/browser-extension");
const extensionDir = join(extensionSrc, ".output/chrome-mv3");
const headed = process.argv.includes("--headed");
const skipBuild = process.argv.includes("--skip-build");

if (!skipBuild) {
  const build = spawnSync("npx", ["wxt", "build"], { cwd: extensionSrc, stdio: "inherit" });
  if (build.status !== 0) throw new Error("wxt build failed");
}

const fixtureHtml = await readFile(join(root, "tests/fixtures/article.html"), "utf8");
const articleUrl = "https://blog.example.com/posts/retrieval-reranking";
const rejectId = "rejectme422xxxxxxxxxxxx";
const token = "e2e-token";

const profileDir = await mkdtemp(join(tmpdir(), "study-studio-e2e-ext-"));

let context = null;
let stub = null;
const results = [];

async function waitFor(label, probe, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${label}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} — ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

/** Service-worker helpers (chrome.runtime.sendMessage cannot target the same SW). */
const sw = (worker, fn, arg) => worker.evaluate(fn, arg);

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url().split("?")[0];
    if (url === articleUrl) return route.fulfill({ contentType: "text/html", body: fixtureHtml });
    if (url.startsWith("http://127.0.0.1:")) return route.continue();
    return route.fulfill({ status: 204, body: "" });
  });

  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await waitFor("hooks", async () => sw(worker, () => Boolean(globalThis.__studyStudio)));
  await sw(worker, () => globalThis.__studyStudio.setCollecting(true));
  await sw(worker, ([url, pairingToken]) => chrome.storage.local.set({ ingestionUrl: url, pairingToken }), ["http://127.0.0.1:9", token]);

  const page = await context.newPage();
  await page.goto(articleUrl);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const p = document.querySelector("article p, main p, p");
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  });
  await page.waitForTimeout(1_200);

  await check("服务停止 → 采集入 IndexedDB", async () => {
    const counts = await waitFor("pending", async () => {
      const status = await sw(worker, () => globalThis.__studyStudio.status());
      return status?.counts?.total > 0 ? status.counts : null;
    });
    return `pending total=${counts.total}, knowledge=${counts.knowledge}`;
  });

  stub = await createStubServer({ pairingToken: token, rejectIds: [rejectId] });
  const liveUrl = stub.url;
  await sw(
    worker,
    async ([url, pairingToken]) => {
      await chrome.storage.local.set({ ingestionUrl: url, pairingToken });
      return globalThis.__studyStudio.saveConnection(url, pairingToken);
    },
    [liveUrl, token]
  );

  await check("启动服务 → 自动同步 → 计数归零", async () => {
    const status = await waitFor("synced", async () => {
      await sw(worker, () => globalThis.__studyStudio.sync());
      const current = await sw(worker, () => globalThis.__studyStudio.status());
      return current?.counts?.total === 0 && current?.connectivity?.state === "online" ? current : null;
    });
    if (stub.events.length < 1) throw new Error("stub received no events");
    return `events=${stub.events.length}, pending=${status.counts.total}`;
  });

  await check("行为事件不含正文", async () => {
    await page.reload();
    await page.waitForTimeout(1_000);
    await sw(worker, () => globalThis.__studyStudio.sync());
    await waitFor("page_session", async () => stub.events.find((event) => event.type === "page_session"));
    const allActivity = stub.events.filter((event) => ["page_session", "selection", "copy", "search_performed", "activity_state"].includes(event.type));
    if (!allActivity.length) throw new Error("no activity events");
    for (const event of allActivity) {
      if (event.content || event.message || event.answer) throw new Error(`${event.type} has body fields`);
      const json = JSON.stringify(event);
      if (/"sanitizedHtml"/.test(json)) throw new Error(`${event.type} leaked html`);
    }
    return `activity=${allActivity.length}`;
  });

  await check("手动同步", async () => {
    const before = stub.events.length;
    await sw(worker, async () => {
      await globalThis.__studyStudio.ingest({
        id: crypto.randomUUID(),
        schemaVersion: 1,
        type: "user_note",
        occurredAt: new Date().toISOString(),
        source: { channel: "browser_extension", url: "https://blog.example.com/posts/retrieval-reranking" },
        note: { text: "手动同步备注" }
      });
      return globalThis.__studyStudio.sync();
    });
    await waitFor("manual note", async () => stub.events.find((event) => event.type === "user_note" && event.note?.text === "手动同步备注"));
    return `delta=${stub.events.length - before}`;
  });

  await check("422 失败展示", async () => {
    await sw(
      worker,
      async (id) =>
        globalThis.__studyStudio.ingest({
          id,
          schemaVersion: 1,
          type: "user_note",
          occurredAt: new Date().toISOString(),
          source: { channel: "browser_extension", url: "https://blog.example.com/posts/retrieval-reranking" },
          note: { text: "should fail" }
        }),
      rejectId
    );
    const failed = await waitFor("failed list", async () => {
      const list = await sw(worker, () => globalThis.__studyStudio.failedList());
      return Array.isArray(list) && list.some((item) => item.eventId === rejectId) ? list : null;
    });
    return `failed=${failed.length}`;
  });
} finally {
  await context?.close().catch(() => {});
  await stub?.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}

const ok = results.length > 0 && results.every((item) => item.ok);
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
