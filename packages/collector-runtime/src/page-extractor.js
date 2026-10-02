import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";
import { extractRichContent } from "./rich-content.js";
import { resolveSiteAdapter, SITE_ADAPTERS } from "./site-adapters.js";
import { canonicalUrlOf } from "./util.js";

const MIN_TEXT_LENGTH = 200;
const MAX_LINK_DENSITY = 0.5;
const MIN_PARAGRAPH_LENGTH = 60;
const LONG_FORM_PARAGRAPH = 300;
const FEED_CARD_COUNT = 5;
const MAX_CARD_TEXT = 400;
const ARTICLE_SCHEMA_TYPES = /^(Article|BlogPosting|NewsArticle|TechArticle|ScholarlyArticle|Report|QAPage|HowTo|Recipe)$/;
const LISTING_PATH = /\/(search|tags?|categories|category|topics|explore|trending|hot|feed|page\/\d+)(\/|$)/i;
const SEARCH_PARAMS = ["q", "query", "keyword", "keywords", "wd", "kw"];
const BLOCK_SELECTOR = "p, li, blockquote, pre, td, th, dd, dt, h1, h2, h3, h4, h5, h6, div, section, article";

function hasArticleSignal(doc) {
  if (/article/i.test(doc.querySelector("meta[property='og:type']")?.content ?? "")) return true;
  return [...doc.querySelectorAll("script[type='application/ld+json']")].some((script) => {
    try {
      const types = [JSON.parse(script.textContent)]
        .flat()
        .flatMap((item) => [item, ...(item?.["@graph"] ?? [])])
        .flatMap((item) => [item?.["@type"]].flat());
      return types.some((type) => ARTICLE_SCHEMA_TYPES.test(type ?? ""));
    } catch {
      return false;
    }
  });
}

/** Home pages, search results and tag/category listings carry no body of their own. */
function isListingUrl({ pathname, search }) {
  if (pathname === "/" || pathname === "") return true;
  if (LISTING_PATH.test(pathname)) return true;
  const params = new URLSearchParams(search);
  return SEARCH_PARAMS.some((key) => params.get(key));
}

const textLength = (text) => text.replace(/\s+/g, "").length;

/** Link share of the text and the longest run of non-link text inside one block element. */
function bodyStats(doc, sanitizedHtml) {
  const template = doc.createElement("template");
  template.innerHTML = sanitizedHtml;
  const walker = doc.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const blocks = new Map();
  let total = 0;
  let linkText = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = textLength(node.data);
    if (!length) continue;
    total += length;
    if (node.parentElement?.closest("a")) {
      linkText += length;
      continue;
    }
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? template.content;
    blocks.set(block, (blocks.get(block) ?? 0) + length);
  }
  return { total, linkText, linkDensity: total ? linkText / total : 1, longestParagraph: Math.max(0, ...blocks.values()) };
}

/** Short repeated items (`article` or feed children) that each link to another page. */
function countFeedCards(doc) {
  const here = doc.defaultView?.location?.pathname;
  const items = new Set([...doc.querySelectorAll("article, [role='feed'] > *")]);
  return [...items].filter(
    (item) =>
      textLength(item.textContent ?? "") <= MAX_CARD_TEXT && [...item.querySelectorAll("a[href]")].some((link) => link.pathname && link.pathname !== here)
  ).length;
}

/** Feeds are mostly links, repeated short cards and lack a single paragraph of real prose. */
function looksLikeList(doc, content, articleSignal) {
  const { total, linkText, linkDensity, longestParagraph } = bodyStats(doc, content.sanitizedHtml ?? "");
  if (total - linkText < MIN_TEXT_LENGTH || linkDensity > MAX_LINK_DENSITY) return true;
  if (longestParagraph < MIN_PARAGRAPH_LENGTH && content.codeBlocks.length === 0 && content.tables.length === 0) return true;
  if (articleSignal || longestParagraph >= LONG_FORM_PARAGRAPH) return false;
  return countFeedCards(doc) >= FEED_CARD_COUNT;
}

function fromHtml(doc, html, options) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const root = doc.createElement("div");
  root.append(...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)));
  return extractRichContent(root, options);
}

function accept(content, meta) {
  if (!content || content.plainText.length < MIN_TEXT_LENGTH) return null;
  const markdown = meta.title && !/^#\s/.test(content.markdown) ? `# ${meta.title}\n\n${content.markdown}` : content.markdown;
  return { ...meta, ...content, markdown };
}

/**
 * Cascade: site adapter → Defuddle → Readability → main/article/[role=main] fallback.
 * Returns null for list pages (feeds, home, search, tag listings) that have no body of their own.
 */
export function extractPageContent(doc = document, { siteAdapters = SITE_ADAPTERS } = {}) {
  const win = doc.defaultView;
  const canonicalUrl = canonicalUrlOf(doc, win);
  const pageTitle = doc.querySelector("meta[property='og:title']")?.content?.trim() || doc.title;
  const location = win?.location ?? new URL(doc.URL);
  const articleSignal = hasArticleSignal(doc);

  const site = resolveSiteAdapter(location, siteAdapters);
  if (site?.isContentPage ? !site.isContentPage(location) : !articleSignal && isListingUrl(location)) return null;
  const generic = (content, meta) => {
    const result = accept(content, meta);
    return result && !looksLikeList(doc, result, articleSignal) ? result : null;
  };

  const siteRoot = site?.select(doc);
  if (siteRoot) {
    const result = accept(extractRichContent(siteRoot, { removeSelectors: site.removeSelectors }), {
      title: pageTitle,
      canonicalUrl,
      extractor: `site:${site.id}`
    });
    if (result) return result;
  }

  try {
    const defuddled = new Defuddle(doc.cloneNode(true), { url: canonicalUrl, useAsync: false }).parse();
    if (defuddled?.content) {
      const result = generic(fromHtml(doc, defuddled.content), { title: defuddled.title || pageTitle, canonicalUrl, extractor: "defuddle" });
      if (result) return result;
    }
  } catch {
    // Defuddle failures fall through to Readability.
  }

  try {
    const article = new Readability(doc.cloneNode(true)).parse();
    if (article?.content) {
      const result = generic(fromHtml(doc, article.content), { title: article.title || pageTitle, canonicalUrl, extractor: "readability" });
      if (result) return result;
    }
  } catch {
    // Readability failures fall through to the DOM fallback.
  }

  const root = doc.querySelector("main, article, [role='main']") ?? doc.body;
  if (!root) return null;
  return generic(extractRichContent(root, { removeSelectors: ["nav", "footer", "aside", "header"] }), {
    title: pageTitle,
    canonicalUrl,
    extractor: "dom_fallback"
  });
}
