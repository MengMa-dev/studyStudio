import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createIngestionServer } from "../services/local-ingestion/src/create-server.js";
import { createLocalIngestionClient } from "../apps/desktop/local-ingestion-client.js";

const root = join(import.meta.dirname, "..");
const fixture = (name) => readFile(join(root, "tests/fixtures", name), "utf8");

async function bundle(entry, globalName) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "iife",
    globalName,
    platform: "browser",
    target: ["chrome120"],
    write: false
  });
  return result.outputFiles[0].text;
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  chromium = null;
}

const channel = process.env.STUDY_STUDIO_CHROME_CHANNEL ?? "chrome";
let browser = null;
let runtimeBundle = "";
let desktopBundle = "";

async function launch() {
  if (!chromium) return null;
  try {
    return await chromium.launch({ channel, headless: true });
  } catch {
    return null;
  }
}

/** Opens `url` served from a fixture, injects the runtime and installs a collector recording events. */
async function openWithCollector(url, html, { captured = false, threshold = { minActiveSeconds: 90, minScrollDepth: 0.35 } } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.route("**/*", (route) =>
    route.request().url() === url ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 204, body: "" })
  );
  await page.goto(url);
  await page.addScriptTag({ content: runtimeBundle });
  await page.evaluate(
    ({ captured, threshold }) => {
      window.__events = [];
      window.__collector = window.StudyStudioCollector.installCollector({
        emit: (event) => window.__events.push(event),
        channel: "browser_extension",
        threshold,
        pageIndex: { lookup: async () => ({ captured }) },
        checkIntervalMs: 200,
        navigationPollMs: 100,
        debounceMs: 50
      });
    },
    { captured, threshold }
  );
  return page;
}

const events = (page, type) => page.evaluate((type) => window.__events.filter((event) => !type || event.type === type), type);
const waitForEvent = (page, type, timeout = 10_000) =>
  page.waitForFunction((type) => window.__events.find((event) => event.type === type), type, { timeout }).then((handle) => handle.jsonValue());

describe("collector runtime in Chrome", { concurrency: false }, () => {
  before(async () => {
    browser = await launch();
    runtimeBundle = await bundle("packages/collector-runtime/src/browser-collector.js", "StudyStudioCollector");
    desktopBundle = await bundle("apps/desktop/inject-entry.js");
  });
  after(() => browser?.close());

  const browserTest = (name, fn) =>
    test(name, async (t) => {
      if (!browser) return t.skip(`Chrome (${channel}) is not available for Playwright`);
      await fn(t);
    });

  browserTest("extracts a generic article with code, table, image and canonical URL", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking?utm_source=x", await fixture("article.html"));
    const content = await page.evaluate(() => window.StudyStudioCollector.extractPageContent(document));
    assert.match(content.extractor, /^(defuddle|readability)$/);
    assert.equal(content.title, "Understanding Vector Retrieval and Reranking");
    assert.equal(content.canonicalUrl, "https://blog.example.com/posts/retrieval-reranking");
    assert.match(content.markdown, /```js\nconst candidates = await index\.search/);
    assert.match(content.markdown, /\| Stage \| Latency \| Precision \|\n\| --- \| --- \| --- \|\n\| Retrieval \| Low \| Medium \|/);
    assert.deepEqual(content.codeBlocks[0].language, "js");
    assert.equal(content.tables.length, 1);
    assert.equal(content.media[0].url, "https://blog.example.com/images/pipeline.png");
    assert.ok(content.links.some((link) => link.url === "https://example.org/cross-encoders"));
    assert.doesNotMatch(content.plainText, /NAVIGATION-SUBSCRIBE|FOOTER-LEGAL-TEXT/);
    await page.close();
  });

  browserTest("uses the GitHub site adapter before generic extractors", async () => {
    const page = await openWithCollector("https://github.com/example/rag-toolkit", await fixture("github-readme.html"));
    const content = await page.evaluate(() => window.StudyStudioCollector.extractPageContent(document));
    assert.equal(content.extractor, "site:github");
    assert.match(content.markdown, /^# rag-toolkit/);
    assert.match(content.markdown, /```bash\nnpm install rag-toolkit\n```/);
    assert.doesNotMatch(content.plainText, /SIDEBAR-ABOUT/);
    await page.close();
  });

  browserTest("captures a page only after the reading threshold is met", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking", await fixture("article.html"), {
      threshold: { minActiveSeconds: 1, minScrollDepth: 0.35 }
    });
    assert.equal((await events(page, "page_opened")).length, 1);
    await page.waitForTimeout(1_500);
    assert.equal((await events(page, "webpage_captured")).length, 0, "no scroll yet");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const captured = await waitForEvent(page, "webpage_captured");
    assert.equal(captured.reason, "threshold");
    assert.equal(captured.readingSignals.maxScrollDepth, 1);
    assert.ok(captured.readingSignals.activeDurationSeconds >= 1);
    await page.close();
  });

  browserTest("copy and notes each qualify a page; merely reopening does not", async () => {
    const html = await fixture("article.html");
    const url = "https://blog.example.com/posts/retrieval-reranking";

    const copyPage = await openWithCollector(url, html);
    await copyPage.evaluate(() => document.dispatchEvent(new Event("copy")));
    assert.equal((await waitForEvent(copyPage, "webpage_captured")).reason, "copy");
    await copyPage.close();

    const notePage = await openWithCollector(url, html);
    await notePage.evaluate(() => window.__collector.addNote("重排依赖召回质量"));
    assert.equal((await waitForEvent(notePage, "user_note")).note.text, "重排依赖召回质量");
    assert.equal((await waitForEvent(notePage, "webpage_captured")).reason, "note");
    await notePage.close();

    const reopened = await openWithCollector(url, html);
    await reopened.waitForTimeout(600);
    assert.equal((await events(reopened, "webpage_captured")).length, 0);
    await reopened.close();
  });

  browserTest("reading time: capturing stay is reported in full, an unqualified stay reports nothing", async () => {
    const html = await fixture("article.html");
    const url = "https://blog.example.com/posts/retrieval-reranking";

    const page = await openWithCollector(url, html);
    await page.evaluate(() => document.dispatchEvent(new Event("copy")));
    const captured = await waitForEvent(page, "webpage_captured");
    await page.waitForTimeout(1_100);
    await page.evaluate(() => window.__collector.stop());
    const [closed] = await events(page, "reading_session_closed");
    assert.equal(closed.sessionId, captured.sessionId);
    assert.equal(closed.source.canonicalUrl, url);
    assert.ok(closed.readingSignals.activeDurationSeconds >= 1);
    await page.close();

    const idle = await openWithCollector(url, html);
    await idle.evaluate(() => window.__collector.stop());
    assert.deepEqual(
      (await events(idle)).map((event) => event.type),
      ["page_opened"]
    );
    await idle.close();
  });

  browserTest("already captured page: never captured again, later stays count only from minRevisitSeconds", async () => {
    const html = await fixture("article.html");
    const url = "https://blog.example.com/posts/retrieval-reranking";
    const threshold = { minActiveSeconds: 90, minScrollDepth: 0.35, minRevisitSeconds: 1 };

    const short = await openWithCollector(url, html, { captured: true, threshold });
    await short.evaluate(() => document.dispatchEvent(new Event("copy")));
    await short.evaluate(() => window.__collector.stop());
    assert.deepEqual(
      (await events(short)).map((event) => event.type),
      ["page_opened"],
      "no capture and no time below the minimum"
    );
    await short.close();

    const long = await openWithCollector(url, html, { captured: true, threshold });
    await long.waitForTimeout(1_200);
    await long.evaluate(() => window.__collector.stop());
    const closed = await events(long, "reading_session_closed");
    assert.equal(closed.length, 1);
    assert.equal(closed[0].captured, false);
    assert.ok(closed[0].readingSignals.activeDurationSeconds >= 1);
    assert.equal((await events(long, "webpage_captured")).length, 0);
    await long.close();
  });

  browserTest("list pages are not extracted: Zhihu home and a generic feed", async () => {
    const zhihu = await openWithCollector("https://www.zhihu.com/", await fixture("zhihu-home.html"));
    assert.equal(await zhihu.evaluate(() => window.StudyStudioCollector.extractPageContent(document)), null);
    await zhihu.evaluate(() => document.dispatchEvent(new Event("copy")));
    await zhihu.waitForTimeout(300);
    assert.equal((await events(zhihu, "webpage_captured")).length, 0);
    await zhihu.close();

    const zhihuWithoutAdapter = await openWithCollector("https://www.zhihu.com/follow", await fixture("zhihu-home.html"));
    assert.equal(
      await zhihuWithoutAdapter.evaluate(() => window.StudyStudioCollector.extractPageContent(document, { siteAdapters: [] })),
      null,
      "content heuristics alone reject the feed"
    );
    await zhihuWithoutAdapter.close();

    const feed = await openWithCollector("https://news.example.com/latest", await fixture("feed.html"));
    assert.equal(await feed.evaluate(() => window.StudyStudioCollector.extractPageContent(document)), null);
    await feed.close();

    const answer = await openWithCollector("https://www.zhihu.com/question/1/answer/2", await fixture("zhihu-answer.html"));
    const content = await answer.evaluate(() => window.StudyStudioCollector.extractPageContent(document));
    assert.equal(content.extractor, "site:zhihu");
    await answer.close();
  });

  browserTest("restarts the page collector on SPA navigation", async () => {
    const page = await openWithCollector("https://blog.example.com/posts/retrieval-reranking", await fixture("article.html"));
    await page.evaluate(() => history.pushState({}, "", "/posts/next"));
    await page.waitForFunction(() => window.__events.filter((event) => event.type === "page_opened").length === 2);
    const opened = await events(page, "page_opened");
    assert.equal(opened[1].source.url, "https://blog.example.com/posts/next");
    await page.close();
  });

  browserTest("ChatGPT: records question and completed answer without backfilling history", async () => {
    const page = await openWithCollector("https://chatgpt.com/c/abc", await fixture("chatgpt.html"));
    await page.waitForTimeout(300);
    assert.deepEqual(
      (await events(page)).map((event) => event.type),
      ["page_opened"]
    );

    await page.fill("#prompt-textarea", "向量召回和重排有什么区别？");
    await page.press("#prompt-textarea", "Enter");
    const question = await waitForEvent(page, "user_message_sent");
    assert.equal(question.message.plainText, "向量召回和重排有什么区别？");
    assert.equal(question.source.platform, "chatgpt");

    await page.evaluate(() => window.fixture.appendTurn("向量召回和重排有什么区别？"));
    await page.evaluate(() => window.fixture.stream("<p>召回负责</p>"));
    await page.waitForTimeout(2_000);
    assert.equal((await events(page, "assistant_response_completed")).length, 0, "still generating");

    await page.evaluate(() => {
      window.fixture.stream(`<p><strong>召回</strong>负责粗筛，重排负责精排。</p>
        <pre><div><div class="flex"><span>python</span><button>Copy code</button></div><div><code class="hljs">scores = reranker(query, docs)</code></div></div></pre>
        <table><thead><tr><th>阶段</th><th>目标</th></tr></thead><tbody><tr><td>召回</td><td>高召回率</td></tr></tbody></table>
        <p>相似度 <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\\cos(q,d)</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">cos(q,d)</span></span></p>`);
      window.fixture.finish();
    });
    const answer = await waitForEvent(page, "assistant_response_completed");
    assert.equal(answer.replyTo, question.id);
    assert.equal(answer.question.plainText, "向量召回和重排有什么区别？");
    assert.match(answer.answer.markdown, /\*\*召回\*\*负责粗筛/);
    assert.match(answer.answer.markdown, /```python\nscores = reranker\(query, docs\)\n```/);
    assert.match(answer.answer.markdown, /\| 阶段 \| 目标 \|/);
    assert.match(answer.answer.markdown, /\$\\cos\(q,d\)\$/);
    assert.doesNotMatch(answer.answer.plainText, /Copy code/);
    assert.equal(answer.answer.codeBlocks[0].language, "python");

    await page.evaluate(() => history.pushState({}, "", "/c/def"));
    await page.waitForFunction(() => window.__events.filter((event) => event.type === "page_opened").length === 2);
    assert.equal((await events(page, "assistant_response_completed")).length, 1);
    await page.close();
  });

  browserTest("ChatGPT 2026 UI: li[data-message-role] transcript with data-message-complete", async () => {
    const page = await openWithCollector("https://chatgpt.com/", await fixture("chatgpt-2026.html"));
    await page.fill("textarea[name='prompt']", "用一句话解释向量召回");
    await page.press("textarea[name='prompt']", "Enter");
    const question = await waitForEvent(page, "user_message_sent");
    assert.equal(question.message.plainText, "用一句话解释向量召回");

    await page.evaluate(() => history.pushState({}, "", "/uc/6abe6f6a"));
    await page.evaluate(() =>
      window.fixture.stream(`<p data-assistant-stream-block="">向量召回是<?marker name="tail"?>按语义相似度找结果。</p>
      <pre data-assistant-stream-block=""><code data-assistant-syntax-highlighted=""><span>results = index.search(query_vector, top_k=10)</span></code><span data-message-content-controls=""><button aria-label="复制密码"></button></span></pre>`)
    );
    await page.waitForTimeout(3_500);
    assert.equal((await events(page, "assistant_response_completed")).length, 0, "incomplete until data-message-complete");

    await page.evaluate(() => window.fixture.finish());
    const answer = await waitForEvent(page, "assistant_response_completed");
    assert.equal(answer.question.plainText, "用一句话解释向量召回");
    assert.equal(answer.source.url, "https://chatgpt.com/uc/6abe6f6a");
    assert.match(answer.answer.markdown, /^向量召回是按语义相似度找结果。/);
    assert.match(answer.answer.markdown, /```\nresults = index\.search\(query_vector, top_k=10\)\n```/);
    assert.doesNotMatch(answer.answer.plainText, /ChatGPT 说|历史回答/);
    await page.close();
  });

  browserTest("DeepSeek: click-send survives assistant shell race and captures reasoning", async () => {
    const page = await openWithCollector("https://chat.deepseek.com/a/chat/s/xyz", await fixture("deepseek.html"));
    await page.fill("textarea[name='search']", "什么是交叉编码器？");
    await page.click("#send");
    const question = await waitForEvent(page, "user_message_sent");
    assert.equal(question.message.plainText, "什么是交叉编码器？");

    // Assistant shell is mounted without markdown — must not permanently block completion.
    await page.waitForTimeout(500);
    assert.equal((await events(page, "assistant_response_completed")).length, 0);

    await page.evaluate(() => window.fixture.think("用户在问交叉编码器……"));
    await page.evaluate(() =>
      window.fixture.stream(`<p class="ds-markdown-paragraph">交叉编码器把查询和文档拼接后一起编码。</p>
      <div class="md-code-block"><div class="md-code-block-banner"><span class="md-code-block-infostring">python</span><button>复制</button></div><pre>model.predict([(q, d)])</pre></div>`)
    );
    await page.evaluate(() => window.fixture.finish());
    const answer = await waitForEvent(page, "assistant_response_completed", 15_000);
    assert.equal(answer.source.platform, "deepseek");
    assert.equal(answer.question.plainText, "什么是交叉编码器？");
    assert.match(answer.answer.markdown, /交叉编码器把查询和文档拼接后一起编码/);
    assert.match(answer.answer.markdown, /```python\nmodel\.predict\(\[\(q, d\)\]\)\n```/);
    assert.doesNotMatch(answer.answer.plainText, /用户在问|历史回答/);
    assert.equal(answer.answer.reasoning.plainText, "用户在问交叉编码器……");
    await page.close();
  });

  browserTest("desktop bridge sends events through the host to the local ingestion service", async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "study-studio-e2e-"));
    const ingestion = await createIngestionServer({ dataDir, pairingToken: "e2e" });
    const port = await ingestion.listen(0);
    t.after(async () => {
      await ingestion.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const client = createLocalIngestionClient({ ingestionUrl: `http://127.0.0.1:${port}`, pairingToken: "e2e" });

    const url = "https://blog.example.com/posts/retrieval-reranking";
    const html = await fixture("article.html");
    const page = await browser.newPage();
    const responses = [];
    await page.exposeFunction("hostSendEvent", async (event) => {
      responses.push(await client.sendEvent(event));
    });
    await page.exposeFunction("hostLookupPage", (canonicalUrl) => client.lookupPage(canonicalUrl));
    await page.addInitScript(() => {
      window.StudyStudioHost = { sendEvent: (event) => window.hostSendEvent(event), lookupPage: (canonicalUrl) => window.hostLookupPage(canonicalUrl) };
    });
    await page.route("**/*", (route) =>
      route.request().url() === url ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 204, body: "" })
    );

    await page.goto(url);
    await page.addScriptTag({ content: desktopBundle });
    await page.waitForFunction(() => window.StudyStudioCollectorInstance);
    await page.evaluate(() => window.StudyStudioCollectorInstance.addNote("桌面端备注"));
    await page.waitForTimeout(500);

    const captured = responses.find((response) => response.artifact?.startsWith("inbox/webpages/"));
    assert.ok(captured, "webpage written to inbox");
    const metadata = JSON.parse(await readFile(join(dataDir, captured.artifact, "metadata.json"), "utf8"));
    assert.equal(metadata.source.channel, "desktop_browser");
    assert.equal(metadata.source.isStrongLearning, true);
    assert.equal(metadata.reason, "note");
    assert.match(await readFile(join(dataDir, captured.artifact, "content.md"), "utf8"), /# Understanding Vector Retrieval/);
    const day = new Date().toISOString().slice(0, 10);
    const types = (await readFile(join(dataDir, "timeline", `${day}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type);
    assert.deepEqual(types, ["user_note", "webpage_captured"], "navigation is not written to the timeline");

    await page.reload();
    await page.addScriptTag({ content: desktopBundle });
    await page.waitForFunction(() => window.StudyStudioCollectorInstance);
    await page.evaluate(() => window.StudyStudioCollectorInstance.addNote("再次打开"));
    await page.waitForTimeout(500);
    assert.equal((await readdir(join(dataDir, "inbox", "webpages"))).length, 1, "reopened page is not captured again");
    await page.close();
  });
});
