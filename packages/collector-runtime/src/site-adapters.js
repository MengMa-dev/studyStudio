/**
 * High-frequency learning sites whose main content is known. Each adapter returns the
 * content root (attached or synthetic) or null to fall through to generic extractors.
 * Optional `isContentPage(location)` whitelists detail pages; everything else on the site
 * (home feeds, topic/search/profile lists) is never captured.
 */
function synthetic(doc, parts) {
  const root = doc.createElement("article");
  for (const part of parts) if (part) root.append(part);
  return root.childElementCount > 0 ? root : null;
}

function heading(doc, level, text) {
  const node = doc.createElement(`h${level}`);
  node.textContent = text;
  return node;
}

function cloneAll(nodes) {
  return [...nodes].map((node) => node.cloneNode(true));
}

export const SITE_ADAPTERS = [
  {
    id: "github",
    matches: ({ hostname }) => hostname === "github.com",
    select: (doc) => doc.querySelector("article.markdown-body") ?? doc.querySelector(".markdown-body"),
    removeSelectors: [".anchor", ".octicon"]
  },
  {
    id: "mdn",
    matches: ({ hostname }) => hostname === "developer.mozilla.org",
    select: (doc) => doc.querySelector("main#content article, article.main-page-content, main article"),
    removeSelectors: [".copy-button", ".play-button", "aside", ".metadata"]
  },
  {
    id: "wikipedia",
    matches: ({ hostname }) => hostname.endsWith(".wikipedia.org"),
    select: (doc) => doc.querySelector("#mw-content-text .mw-parser-output"),
    removeSelectors: [".mw-editsection", "sup.reference", ".navbox", ".metadata", "#toc", ".toc", ".reflist", ".mw-empty-elt"]
  },
  {
    id: "stackoverflow",
    matches: ({ hostname }) => hostname === "stackoverflow.com" || hostname.endsWith(".stackexchange.com"),
    isContentPage: ({ pathname }) => /^\/questions\/\d+/.test(pathname),
    select: (doc) => {
      const question = doc.querySelector("#question .s-prose, .question .s-prose");
      if (!question) return null;
      const title = doc.querySelector("#question-header h1")?.textContent?.trim();
      const answers = [...doc.querySelectorAll(".answer")].flatMap((answer, index) => {
        const body = answer.querySelector(".s-prose");
        if (!body) return [];
        const accepted = answer.classList.contains("accepted-answer") ? "（已采纳）" : "";
        return [heading(doc, 2, `回答 ${index + 1}${accepted}`), body.cloneNode(true)];
      });
      return synthetic(doc, [title && heading(doc, 1, title), question.cloneNode(true), ...answers]);
    },
    removeSelectors: [".js-post-menu", ".comments"]
  },
  {
    id: "zhihu",
    matches: ({ hostname }) => hostname === "zhuanlan.zhihu.com" || hostname === "www.zhihu.com",
    isContentPage: ({ hostname, pathname }) =>
      hostname === "zhuanlan.zhihu.com" ? /^\/p\/\d+/.test(pathname) : /^\/(question|pin|zvideo)\/\d+/.test(pathname),
    select: (doc) => {
      const post = doc.querySelector(".Post-RichText");
      if (post) return post;
      const title = doc.querySelector(".QuestionHeader-title")?.textContent?.trim();
      const answers = doc.querySelectorAll(".AnswerItem .RichContent-inner, .QuestionAnswer-content .RichContent-inner");
      if (answers.length === 0) return null;
      return synthetic(doc, [title && heading(doc, 1, title), ...cloneAll(answers)]);
    },
    removeSelectors: [".ContentItem-actions", ".RichContent-actions"]
  },
  {
    id: "juejin",
    matches: ({ hostname }) => hostname === "juejin.cn",
    isContentPage: ({ pathname }) => /^\/post\/\d+/.test(pathname),
    select: (doc) => doc.querySelector(".article-content, #article-root"),
    removeSelectors: [".code-block-extension-header"]
  },
  {
    id: "csdn",
    matches: ({ hostname }) => hostname.endsWith(".csdn.net"),
    isContentPage: ({ pathname }) => /\/article\/details\/\d+/.test(pathname),
    select: (doc) => doc.querySelector("#content_views"),
    removeSelectors: [".hljs-button", ".pre-numbering", ".hide-preCode-box"]
  },
  {
    id: "cnblogs",
    matches: ({ hostname }) => hostname === "www.cnblogs.com",
    isContentPage: ({ pathname }) => /^\/[^/]+\/(p|archive\/\d{4}\/\d{2}\/\d{2})\/[^/]+/.test(pathname),
    select: (doc) => doc.querySelector("#cnblogs_post_body"),
    removeSelectors: []
  }
];

export function resolveSiteAdapter(location, adapters = SITE_ADAPTERS) {
  return adapters.find((adapter) => adapter.matches(location)) ?? null;
}
