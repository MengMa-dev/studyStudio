import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { contentHash } from "./util.js";

const ALWAYS_REMOVE = "script,style,noscript,template,button,svg,canvas,iframe,form,input,textarea,select,[hidden]";
const BLOCK_ELEMENTS = "p,div,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote,table,ul,ol,section,article,figure,figcaption,hr";

function cellText(cell) {
  return cell.textContent.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

export function tableToMarkdown(table) {
  const rows = [...table.querySelectorAll("tr")]
    .filter((row) => row.closest("table") === table)
    .map((row) => [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH").map(cellText))
    .filter((row) => row.length > 0);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const [head, ...body] = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  return [head, Array(width).fill("---"), ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function createMarkdownConverter() {
  const converter = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx", bulletListMarker: "-", emDelimiter: "*" });
  converter.addRule("table", { filter: "table", replacement: (_content, node) => `\n\n${tableToMarkdown(node)}\n\n` });
  converter.addRule("strikethrough", { filter: ["del", "s", "strike"], replacement: (content) => `~~${content}~~` });
  converter.addRule("math", {
    filter: (node) => node.nodeName === "SPAN" && node.hasAttribute("data-math"),
    replacement: (_content, node) => {
      const tex = node.getAttribute("data-math");
      return node.getAttribute("data-display") === "block" ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    }
  });
  return converter;
}

const converter = createMarkdownConverter();

function blockText(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  clone.querySelectorAll(BLOCK_ELEMENTS).forEach((node) => node.append("\n"));
  clone.querySelectorAll("td,th").forEach((node) => node.append("\t"));
  return clone.textContent
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function replaceMath(root, doc) {
  const toSpan = (node, display) => {
    const tex = node.querySelector("annotation[encoding='application/x-tex']")?.textContent?.trim();
    if (!tex) return;
    const span = doc.createElement("span");
    span.setAttribute("data-math", tex);
    span.setAttribute("data-display", display);
    span.textContent = tex;
    node.replaceWith(span);
  };
  root.querySelectorAll(".katex-display").forEach((node) => toSpan(node, "block"));
  root.querySelectorAll(".katex").forEach((node) => toSpan(node, "inline"));
}

function detectLanguage(pre, code, getCodeLanguage) {
  const fromAdapter = getCodeLanguage?.(pre);
  if (fromAdapter) return fromAdapter;
  for (const node of [code, pre]) {
    if (!node) continue;
    const match = [...node.classList].map((name) => /^(?:language|lang)-(.+)$/.exec(name)).find(Boolean);
    if (match) return match[1];
    if (node.dataset.language) return node.dataset.language;
  }
  return "";
}

function normalizeCodeBlocks(root, doc, getCodeLanguage) {
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    const language = detectLanguage(pre, code, getCodeLanguage).trim().toLowerCase();
    const text = (code ?? pre).textContent.replace(/\n$/, "");
    const nextPre = doc.createElement("pre");
    const nextCode = doc.createElement("code");
    if (language) nextCode.className = `language-${language}`;
    nextCode.textContent = text;
    nextPre.append(nextCode);
    pre.replaceWith(nextPre);
  });
}

function absolutizeUrls(root) {
  root.querySelectorAll("img").forEach((image) => {
    const url = image.currentSrc || image.src || image.getAttribute("data-src") || "";
    if (url) image.setAttribute("src", url);
  });
  root.querySelectorAll("a[href]").forEach((link) => link.setAttribute("href", link.href));
}

/**
 * Converts a rendered DOM subtree into sanitized HTML, Markdown and plain text plus
 * structured code blocks, tables, links and media references.
 */
export function extractRichContent(root, { removeSelectors = [], getCodeLanguage } = {}) {
  const doc = root.ownerDocument;
  const clone = root.cloneNode(true);
  replaceMath(clone, doc);
  normalizeCodeBlocks(clone, doc, getCodeLanguage);
  absolutizeUrls(clone);
  clone.querySelectorAll([ALWAYS_REMOVE, ...removeSelectors].join(",")).forEach((node) => node.remove());

  const sanitizedHtml = DOMPurify.sanitize(clone.innerHTML, { USE_PROFILES: { html: true } }).trim();
  const template = doc.createElement("template");
  template.innerHTML = sanitizedHtml;
  const sanitizedRoot = template.content;
  const markdown = converter
    .turndown(sanitizedHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const plainText = blockText(sanitizedRoot);

  const links = [];
  const seenLinks = new Set();
  sanitizedRoot.querySelectorAll("a[href]").forEach((link) => {
    const url = link.getAttribute("href");
    if (!/^https?:/i.test(url) || seenLinks.has(url)) return;
    seenLinks.add(url);
    links.push({ text: link.textContent.trim(), url });
  });

  return {
    markdown,
    plainText,
    sanitizedHtml,
    contentHash: contentHash(plainText),
    codeBlocks: [...sanitizedRoot.querySelectorAll("pre > code")].map((code) => ({
      language: (/language-(\S+)/.exec(code.className) ?? [])[1] ?? "",
      code: code.textContent
    })),
    tables: [...sanitizedRoot.querySelectorAll("table")].map(tableToMarkdown).filter(Boolean),
    links,
    media: [...sanitizedRoot.querySelectorAll("img")]
      .map((image) => ({ type: "image", url: image.getAttribute("src") ?? "", alt: image.getAttribute("alt") ?? "" }))
      .filter((item) => item.url)
  };
}
