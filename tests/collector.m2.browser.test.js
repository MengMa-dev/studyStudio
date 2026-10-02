import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const fixture = (name) => readFile(join(root, "tests/fixtures", name), "utf8");

async function bundle() {
  const result = await build({
    entryPoints: [join(root, "packages/collector-runtime/src/browser-collector.js")],
    bundle: true,
    format: "iife",
    globalName: "StudyStudioCollector",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    define: { __STUDY_STUDIO_DEV__: "false" }
  });
  return result.outputFiles[0].text;
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  chromium = null;
}

const channel = process.env.STUDY_STUDIO_CHROME_CHANNEL ?? "chromium";
let browser = null;
let runtimeBundle = "";

async function openWithCollector(url, html, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.route("**/*", (route) =>
    route.request().url() === url ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 204, body: "" })
  );
  await page.goto(url);
  await page.addScriptTag({ content: runtimeBundle });
  await page.evaluate((opts) => {
    window.__events = [];
    window.__presence = [];
    window.__collector = window.StudyStudioCollector.installCollector({
      emit: (event) => window.__events.push(event),
      channel: "browser_extension",
      threshold: opts.threshold ?? { minActiveSeconds: 90, minScrollDepth: 0.35 },
      pageIndex: { lookup: async () => ({ captured: opts.captured ?? false }) },
      activityEnabled: opts.activityEnabled ?? true,
      category: opts.category ?? "neutral",
      captureHints: opts.captureHints ?? null,
      checkIntervalMs: 200,
      navigationPollMs: 100,
      debounceMs: 50,
      onPresence: (payload) => window.__presence.push(payload),
      onSearch: (href) => {
        const parsed = new URL(href);
        if (parsed.searchParams.get("q")) {
          window.__events.push({
            type: "search_performed",
            search: { engine: "google", query: parsed.searchParams.get("q") }
          });
        }
      }
    });
  }, options);
  return page;
}

const events = (page, type) => page.evaluate((type) => window.__events.filter((event) => !type || event.type === type), type);
const waitForEvent = (page, type, timeout = 10_000) =>
  page.waitForFunction((type) => window.__events.find((event) => event.type === type), type, { timeout }).then((handle) => handle.jsonValue());

describe("collector runtime M2 behaviour", { concurrency: false }, () => {
  before(async () => {
    browser = chromium ? await chromium.launch({ channel, headless: true }).catch(() => null) : null;
    runtimeBundle = await bundle();
  });
  after(() => browser?.close());

  const browserTest = (name, fn) =>
    test(name, async (t) => {
      if (!browser) return t.skip(`Chrome (${channel}) is not available for Playwright`);
      await fn(t);
    });

  browserTest("selection/copy emit truncated snippets and page_session on stop", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking", await fixture("article.html"));
    await page.evaluate(() => {
      const p = document.querySelector("article p, p");
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.dispatchEvent(new Event("copy", { bubbles: true }));
    });
    const selection = await waitForEvent(page, "selection");
    assert.ok(selection.snippet.text.length >= 2);
    assert.ok(selection.snippet.text.length <= 500);
    assert.equal(typeof selection.snippet.isCode, "boolean");
    const copy = await waitForEvent(page, "copy");
    assert.ok(copy.snippet.text.length >= 2);
    await page.evaluate(() => window.__collector.stop());
    const sessions = await events(page, "page_session");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session.captured, true);
    assert.ok(sessions[0].session.exposure);
    assert.ok(Array.isArray(sessions[0].session.exposure.sections));
    assert.ok(sessions[0].session.exposure.page_coverage >= 0);
    await page.close();
  });

  browserTest("unrelated pages omit url/title/exposure in page_session", async () => {
    const page = await openWithCollector("https://weibo.com/feed", await fixture("feed.html"), { category: "unrelated" });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__collector.stop());
    const all = await events(page);
    assert.ok(!all.some((event) => event.type === "page_opened"));
    const sessions = all.filter((event) => event.type === "page_session");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session.category, "unrelated");
    assert.equal(sessions[0].session.url, undefined);
    assert.equal(sessions[0].session.title, undefined);
    assert.equal(sessions[0].session.exposure, undefined);
    assert.ok(sessions[0].session.domain);
    await page.close();
  });

  browserTest("captureHints fromSearch forces webpage_captured without threshold", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking", await fixture("article.html"), {
      threshold: { minActiveSeconds: 90, minScrollDepth: 1 },
      captureHints: { fromSearch: true }
    });
    await page.waitForTimeout(500);
    const captured = await waitForEvent(page, "webpage_captured");
    assert.ok(captured);
    await page.close();
  });

  browserTest("ChatGPT events include conversationId from URL", async () => {
    const page = await openWithCollector("https://chatgpt.com/c/verify-thread", await fixture("chatgpt.html"), { activityEnabled: false });
    await page.fill("#prompt-textarea", "什么是向量召回？");
    await page.press("#prompt-textarea", "Enter");
    const question = await waitForEvent(page, "user_message_sent");
    assert.equal(question.conversationId, "verify-thread");
    await page.evaluate(() => {
      window.fixture.appendTurn("什么是向量召回？");
      window.fixture.stream("<p>粗筛候选。</p>");
      window.fixture.finish();
    });
    const answer = await waitForEvent(page, "assistant_response_completed");
    assert.equal(answer.conversationId, "verify-thread");
    await page.close();
  });

  browserTest("exposure tracker reports section coverage", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking", await fixture("article.html"));
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(1_500);
    await page.evaluate(() => window.__collector.stop());
    const [session] = await events(page, "page_session");
    assert.ok(session.session.exposure.sections.length >= 1);
    assert.ok(session.session.exposure.top_blocks.length >= 0);
    assert.ok(session.session.exposure.page_coverage >= 0);
    await page.close();
  });
});
