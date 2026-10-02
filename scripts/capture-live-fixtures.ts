/**
 * Captures trimmed HTML fixtures from live sites (search results, long docs, AI chats) for M2 regression tests.
 * Writes tests/fixtures/<name>.html plus a JSON report (link forms, URL timelines, DOM shape) to the temp dir.
 * Usage: [ENGINES=google,bing] tsx scripts/capture-live-fixtures.ts [search|docs|chat ...] [--headed]
 * Uses the persistent profile (STUDY_STUDIO_BROWSER_PROFILE) so ChatGPT / DeepSeek logins apply; only one browser may use it.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const fixturesDir = join(root, "tests/fixtures");
const profileDir = process.env.STUDY_STUDIO_BROWSER_PROFILE ?? join(root, ".browser-profile");
const headed = process.argv.includes("--headed");
const groups = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const today = new Date().toLocaleDateString("sv-SE");
const query = "langgraph interrupt";
const question = "用一句话解释向量召回";

type Sanitize = { root: string; remove?: string[]; keepClass?: "all" | "none" | "short"; keepHead?: boolean; flattenPre?: boolean };
type Report = Record<string, unknown>;

/*
 * Runs in the page. Kept as source text so the bundler cannot inject helpers (e.g. __name) into it.
 * Keeps document structure, ids, roles, aria labels, data-* and link attributes; drops scripts, media and styles.
 */
const SANITIZE_SOURCE = String.raw`(opts) => {
  const source = document.querySelector(opts.root);
  if (!source) return null;
  const hosts = [source, ...source.querySelectorAll("*")].filter((node) => node.shadowRoot && node.shadowRoot.querySelector("pre"));
  hosts.forEach((node, index) => node.setAttribute("data-capture-shadow", String(index)));
  const clone = source.cloneNode(true);
  hosts.forEach((node, index) => {
    node.removeAttribute("data-capture-shadow");
    const copy = clone.matches("[data-capture-shadow='" + index + "']") ? clone : clone.querySelector("[data-capture-shadow='" + index + "']");
    if (!copy) return;
    copy.removeAttribute("data-capture-shadow");
    const placeholder = document.createElement("div");
    placeholder.setAttribute("data-capture-shadow-root", "");
    placeholder.innerHTML = node.shadowRoot.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
    copy.prepend(placeholder);
  });
  if (opts.flattenPre) {
    for (const pre of clone.querySelectorAll("pre")) {
      const language = [...pre.querySelectorAll("code, [class*='language-']"), pre].map((n) => ((n.getAttribute("class") || "").match(/language-[\w+-]+/) || [])[0]).find(Boolean);
      const text = pre.textContent;
      const code = document.createElement("code");
      if (language) code.className = language;
      code.textContent = text;
      pre.replaceChildren(code);
    }
  }
  const drop = ["script:not([type='application/ld+json'])", "style", "link", "noscript", "iframe", "svg", "img", "picture", "video", "audio", "canvas", "template", "object", "embed", "input[type='hidden']", ...(opts.remove ?? [])];
  for (const selector of drop) clone.querySelectorAll(selector).forEach((node) => node.remove());
  const keep = /^(href|ping|mu|id|role|name|placeholder|type|lang|datetime|colspan|rowspan|tabindex|title|aria-[a-z-]+|data-[a-z0-9_-]+)$/;
  const nodes = [clone, ...clone.querySelectorAll("*")];
  for (const node of nodes) {
    for (const attr of [...node.attributes]) {
      if (attr.name === "class") {
        if (opts.keepClass === "none") node.removeAttribute("class");
        else if (opts.keepClass === "short") {
          const short = attr.value.split(/\s+/).filter((c) => c && c.length <= 40 && !/[:\[\]\/]/.test(c)).slice(0, 4).join(" ");
          short ? node.setAttribute("class", short) : node.removeAttribute("class");
        }
        continue;
      }
      if (!keep.test(attr.name)) node.removeAttribute(attr.name);
      else if (attr.value.length > 400) node.setAttribute(attr.name, attr.value.slice(0, 400));
    }
  }
  const comments = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const stale = [];
  for (let node = comments.nextNode(); node; node = comments.nextNode()) stale.push(node);
  stale.forEach((node) => node.remove());
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement && text.parentElement.closest("pre, code, textarea")) continue;
    text.data = text.data.replace(/\s+/g, " ");
  }
  for (const placeholder of clone.querySelectorAll("[data-capture-shadow-root]")) {
    const template = document.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    template.content.append(...placeholder.childNodes);
    placeholder.replaceWith(template);
  }
  const head = [];
  if (opts.keepHead) {
    for (const meta of document.querySelectorAll("meta[property^='og:'], meta[name='description'], link[rel='canonical'], script[type='application/ld+json']")) {
      const copy = meta.cloneNode(true);
      for (const attr of [...copy.attributes]) if (!/^(property|name|content|rel|href|type)$/.test(attr.name)) copy.removeAttribute(attr.name);
      head.push(copy.outerHTML);
    }
  }
  return { html: clone.outerHTML, head, title: document.title, lang: document.documentElement.lang || "" };
}`;

async function sanitize(page: Page, options: Sanitize) {
  return page.evaluate(`(${SANITIZE_SOURCE})(${JSON.stringify(options)})`) as Promise<{ html: string; head: string[]; title: string; lang: string } | null>;
}

async function saveFixture(page: Page, name: string, options: Sanitize, note: string) {
  const result = await sanitize(page, options);
  if (!result) throw new Error(`${name}: root ${options.root} not found at ${page.url()}`);
  const body = options.root === "body" ? result.html : `<body>\n${result.html}\n</body>`;
  const html = [
    "<!doctype html>",
    `<!-- Live capture ${today}: ${page.url()} — ${note}. Trimmed by scripts/capture-live-fixtures.ts -->`,
    `<html lang="${result.lang || "en"}">`,
    `<head><meta charset="utf-8"><title>${escapeHtml(result.title)}</title>${result.head.join("")}</head>`,
    body,
    "</html>",
    ""
  ].join("\n");
  await writeFile(join(fixturesDir, `${name}.html`), html);
  console.log(`saved ${name}.html (${Math.round(html.length / 1024)} KB)`);
  return html.length;
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function launch(): Promise<BrowserContext> {
  const probe = await chromium.launch({ channel: "chromium", headless: true });
  const version = probe.version();
  await probe.close();
  return chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  });
}

const blocked = (page: Page) =>
  page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    return (
      /\/sorry\/|captcha|wappass|verify/i.test(location.href) || /unusual traffic|异常流量|安全验证|百度安全验证|verify you are human|人机验证/i.test(text)
    );
  });

const SEARCH_PAGES = [
  {
    engine: "google",
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
    root: "#search, #rso, #main",
    links: "#search a[href]:has(h3), #rso a[href]:has(h3)"
  },
  { engine: "bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, root: "#b_results", links: "#b_results li.b_algo h2 a" },
  {
    engine: "baidu",
    url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    root: "#content_left",
    links: "#content_left .result h3 a, #content_left .c-container h3 a"
  },
  {
    engine: "github",
    url: `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`,
    root: "[data-testid='results-list'], main",
    links: "[data-testid='results-list'] .search-title a, [data-testid='results-list'] h3 a"
  }
];

async function captureSearch(context: BrowserContext, report: Report) {
  const only = process.env.ENGINES?.split(",");
  for (const target of SEARCH_PAGES.filter((item) => !only || only.includes(item.engine))) {
    const page = await context.newPage();
    try {
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(4_000);
      if (await blocked(page)) {
        report[`search-${target.engine}`] = { skipped: "captcha / blocked", url: page.url() };
        console.log(`skip ${target.engine}: blocked at ${page.url()}`);
        continue;
      }
      const links = await page.$$eval(target.links, (anchors) =>
        anchors.slice(0, 8).map((a) => {
          const container = a.closest("[mu], .result, .c-container, li, [data-hveid]");
          return {
            text: (a.textContent ?? "").trim().slice(0, 80),
            hrefAttr: a.getAttribute("href"),
            resolvedHref: (a as HTMLAnchorElement).href,
            ping: a.getAttribute("ping"),
            dataAttrs: Object.fromEntries([...a.attributes].filter((x) => x.name.startsWith("data-")).map((x) => [x.name, x.value.slice(0, 120)])),
            containerMu: container?.getAttribute("mu") ?? null
          };
        })
      );
      const rootSelector = (await page.$(target.root.split(", ")[0]!)) ? target.root.split(", ")[0]! : target.root.split(", ").at(-1)!;
      const size = await saveFixture(
        page,
        `search-${target.engine}`,
        { root: rootSelector, keepClass: "short", remove: ["[aria-hidden='true']:empty"] },
        `search "${query}"`
      );
      report[`search-${target.engine}`] = { url: page.url(), root: rootSelector, size, links };
    } catch (error) {
      report[`search-${target.engine}`] = { error: String(error), url: page.url() };
      console.log(`fail ${target.engine}: ${error}`);
    } finally {
      await page.close();
    }
  }
}

const DOC_PAGES = [
  { name: "langgraph-hitl", url: "https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/" },
  { name: "mdn-intersection-observer", url: "https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API" }
];

async function captureDocs(context: BrowserContext, report: Report) {
  for (const target of DOC_PAGES) {
    const page = await context.newPage();
    try {
      await page.goto(target.url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      const shape = await page.evaluate(() => ({
        url: location.href,
        headings: [...document.querySelectorAll("main h1, main h2, main h3, article h1, article h2, article h3")].map(
          (h) => `${h.tagName} ${(h.textContent ?? "").trim().slice(0, 60)}`
        ),
        blocks: Object.fromEntries(
          ["h1", "h2", "h3", "h4", "p", "li", "pre", "table", "blockquote"].map((tag) => [tag, document.querySelectorAll(`main ${tag}, article ${tag}`).length])
        ),
        mintlifyParagraphs: document.querySelectorAll("[data-as='p']").length,
        shadowHosts: [...document.querySelectorAll("*")]
          .filter((node) => node.shadowRoot)
          .reduce<Record<string, number>>((acc, node) => {
            const key = `${node.tagName.toLowerCase()}${node.shadowRoot!.querySelector("pre") ? " (pre inside)" : ""}`;
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
        landmarks: Object.fromEntries(["main", "article", "nav", "aside", "header", "footer"].map((tag) => [tag, document.querySelectorAll(tag).length]))
      }));
      const size = await saveFixture(
        page,
        `doc-${target.name}`,
        { root: "body", keepClass: "short", keepHead: true, flattenPre: true, remove: ["button", "form", "dialog", "[hidden]"] },
        "long doc for content-exposure tests"
      );
      report[`doc-${target.name}`] = { requested: target.url, size, ...shape };
    } catch (error) {
      report[`doc-${target.name}`] = { error: String(error), url: page.url() };
      console.log(`fail ${target.name}: ${error}`);
    } finally {
      await page.close();
    }
  }
}

/* Attribute names / test ids on message-related nodes, used to diff against the existing fixtures. */
const DESCRIBE_SOURCE = String.raw`() => {
  const attrs = (node) => Object.fromEntries([...node.attributes].filter((a) => a.name !== "style").map((a) => [a.name, a.value.slice(0, 100)]));
  const composer = document.querySelector("#prompt-textarea, textarea, [contenteditable='true']");
  const pick = (selector) => [...document.querySelectorAll(selector)].slice(0, 6).map((n) => ({ tag: n.tagName, ...attrs(n), text: (n.innerText || "").slice(0, 60) }));
  return {
    url: location.href,
    title: document.title,
    composer: composer && { tag: composer.tagName, ...attrs(composer) },
    buttons: [...document.querySelectorAll("button, [role='button']")]
      .map((b) => ({ tag: b.tagName, ...attrs(b), text: (b.innerText || "").trim().slice(0, 30) }))
      .filter((b) => b["aria-label"] || b["data-testid"] || /ds-button--primary/.test(b.class || ""))
      .slice(0, 50),
    dataAttrs: [...new Set([...document.querySelectorAll("main *, #root *")].flatMap((n) => [...n.attributes].map((a) => a.name)).filter((n) => n.startsWith("data-")))],
    chatgpt: {
      authorRole: pick("[data-message-author-role]"),
      messageRole: pick("[data-message-role]"),
      turns: pick("[data-testid^='conversation-turn'], article[data-turn], [data-turn]"),
      transcript: pick("[data-conversation-transcript]"),
      markdown: pick(".markdown, [data-assistant-markdown]")
    },
    deepseek: {
      messages: pick(".ds-message"),
      virtual: pick("[data-virtual-list-item-key]"),
      markdown: pick(".ds-markdown"),
      think: pick(".ds-think-content, [class*='ds-think']"),
      collapsible: pick(".ds-collapsible-text")
    }
  };
}`;

/* Send / stop control and streaming markers, sampled while the answer streams. */
const SUBMIT_STATE_SOURCE = String.raw`(() => {
  const attrs = (node) => node && Object.fromEntries([...node.attributes].filter((a) => a.name !== "style" && !a.name.startsWith("data-octane")).map((a) => [a.name, a.value.slice(0, 300)]));
  const composer = document.querySelector("textarea");
  const deepseekButton = [...document.querySelectorAll(".ds-button--primary, [role='button'].ds-button")].filter((b) => composer && composer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
  const last = [...document.querySelectorAll("[data-message-role='assistant'], .ds-message")].at(-1);
  return {
    url: location.href,
    submit: attrs(document.querySelector("[data-composer-submit], [data-testid='send-button'], [data-testid='stop-button']") || deepseekButton),
    lastMessage: attrs(last),
    markers: ["[aria-label*='停止']", "[aria-label*='Stop']", ".ds-loading", ".ds-button--loading", "[data-message-streaming]", "[data-testid='stop-button']", ".ds-think-content"].filter((s) => document.querySelector(s))
  };
})()`;

const CHATS = [
  {
    name: "chatgpt",
    url: "https://chatgpt.com/",
    composer: "#prompt-textarea, textarea[name='prompt'], [data-mobile-composer-prompt]",
    generating: "[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']",
    root: "main",
    remove: [
      "[data-testid*='profile']",
      "[data-testid*='account']",
      "nav",
      "aside",
      "#stage-slideover-sidebar",
      "[data-testid='model-switcher-dropdown-button']"
    ]
  },
  {
    name: "deepseek",
    url: "https://chat.deepseek.com/",
    composer: "textarea#chat-input, textarea[name='search'], textarea[placeholder*='DeepSeek'], textarea",
    generating: "[aria-label*='停止'], [aria-label*='Stop'], .ds-loading, .ds-button--loading",
    root: "#root",
    remove: []
  }
];

async function captureChats(context: BrowserContext, report: Report) {
  const only = process.env.CHATS?.split(",");
  for (const target of CHATS.filter((item) => !only || only.includes(item.name))) {
    const page = await context.newPage();
    try {
      const timeline: { ms: number; url: string; event: string }[] = [];
      const started = Date.now();
      const mark = (event: string) => timeline.push({ ms: Date.now() - started, url: page.url(), event });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) mark("framenavigated");
      });
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(6_000);
      mark("loaded");
      const before = await page.evaluate(`(${DESCRIBE_SOURCE})()`);
      const composer = page.locator(target.composer).first();
      await composer.click({ timeout: 15_000 });
      await composer.pressSequentially(question, { delay: 30 });
      await page.keyboard.press("Enter");
      const sentAt = Date.now() - started;
      mark("sent");
      let lastUrl = page.url();
      let streaming: unknown = null;
      const samples: { ms: number; state: unknown }[] = [];
      let lastState = "";
      for (let elapsed = 0; elapsed < 90_000; elapsed += 250) {
        await page.waitForTimeout(250);
        if (page.url() !== lastUrl) {
          lastUrl = page.url();
          mark("url-changed (poll)");
        }
        const state = await page.evaluate(SUBMIT_STATE_SOURCE);
        if (JSON.stringify(state) !== lastState) {
          lastState = JSON.stringify(state);
          samples.push({ ms: Date.now() - started, state });
        }
        const generating = await page.locator(target.generating).count();
        if (generating && !streaming) streaming = await page.evaluate(`(${DESCRIBE_SOURCE})()`);
        if (!generating && elapsed > 5_000) break;
      }
      mark("generation-finished");
      await page.waitForTimeout(3_000);
      mark("settled");
      const done = await page.evaluate(`(${DESCRIBE_SOURCE})()`);
      const sidebar = target.name === "deepseek" ? await deepseekSidebarSelectors(page) : [];
      const size = await saveFixture(
        page,
        `${target.name}-live-${today}`,
        { root: target.root, keepClass: "all", remove: [...target.remove, ...sidebar] },
        `new conversation, question "${question}"; account / sidebar removed`
      );
      report[`${target.name}-live`] = { sentAt, timeline, samples, size, sidebarRemoved: sidebar, before, streaming, done };
    } catch (error) {
      report[`${target.name}-live`] = { error: String(error), url: page.url() };
      console.log(`fail ${target.name}: ${error}`);
    } finally {
      await page.close();
    }
  }
}

/* DeepSeek has no semantic sidebar landmark: mark the column that holds history links so it can be dropped. */
async function deepseekSidebarSelectors(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector("textarea");
    const history = [...document.querySelectorAll("a[href*='/a/chat/s/']")];
    const marked: string[] = [];
    let index = 0;
    for (const link of history) {
      let node: Element | null = link;
      while (node?.parentElement && !node.parentElement.contains(composer)) node = node.parentElement;
      if (node && node !== document.body && !node.hasAttribute("data-capture-sidebar")) {
        node.setAttribute("data-capture-sidebar", String(index++));
        marked.push(`[data-capture-sidebar='${index - 1}']`);
      }
    }
    return marked;
  });
}

const context = await launch();
const report: Report = { date: today, query, question };
try {
  if (groups.length === 0 || groups.includes("search")) await captureSearch(context, report);
  if (groups.length === 0 || groups.includes("docs")) await captureDocs(context, report);
  if (groups.length === 0 || groups.includes("chat")) await captureChats(context, report);
} finally {
  await context.close();
}
const reportPath = join(tmpdir(), `live-fixtures-${groups.join("-") || "all"}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(reportPath);
