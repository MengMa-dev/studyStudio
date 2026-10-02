import { extractRichContent } from "./rich-content.js";

/**
 * Conversation adapter contract:
 *   platform, matches(location), getComposer(doc), getUserMessages(doc), getAssistantMessages(doc),
 *   isGenerating(doc), extractMessage(node), optional isSendButton(target), stableMs.
 * Message node lists must be in document order.
 */

function readEditable(node) {
  if (!node) return "";
  return ("value" in node ? node.value : node.innerText ?? node.textContent ?? "").trim();
}

function chatgptCodeLanguage(pre) {
  const header = pre.querySelector(":scope > div > div:first-child");
  if (!header || header.querySelector("code")) return "";
  return (header.querySelector("span")?.textContent ?? header.firstChild?.textContent ?? "").trim();
}

/* Supports both the classic UI (data-message-author-role) and the 2026 UI (li[data-message-role]). */
export const chatgptAdapter = {
  platform: "chatgpt",
  stableMs: 1_500,
  matches: ({ hostname }) => hostname === "chatgpt.com" || hostname === "chat.openai.com",
  getComposer: (doc) => doc.querySelector("#prompt-textarea, textarea[name='prompt'], [data-mobile-composer-prompt]") ?? doc.querySelector("form textarea, form [contenteditable='true']"),
  getUserMessages: (doc) => [...doc.querySelectorAll("[data-message-author-role='user'], [data-message-role='user']")],
  getAssistantMessages: (doc) => [...doc.querySelectorAll("[data-message-author-role='assistant'], [data-message-role='assistant']")],
  isGenerating: (doc) => {
    if (doc.querySelector("[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']")) return true;
    const last = [...doc.querySelectorAll("[data-message-role='assistant']")].at(-1);
    return Boolean(last && !last.hasAttribute("data-message-complete"));
  },
  isSendButton: (target) => Boolean(target.closest?.("[data-testid='send-button'], [data-composer-submit], button[aria-label*='Send'], button[aria-label*='发送']")),
  readComposer: (doc) => readEditable(chatgptAdapter.getComposer(doc)),
  readUserMessage: (node) => (node.querySelector("[data-user-message-copy], .whitespace-pre-wrap") ?? node).innerText.trim(),
  extractMessage: (node) => ({
    role: "assistant",
    ...extractRichContent(node.querySelector(".markdown, [data-assistant-markdown]") ?? node, {
      getCodeLanguage: chatgptCodeLanguage,
      removeSelectors: ["[data-testid*='copy']", "[data-message-content-controls]", "[data-assistant-placeholder-slot]", "[data-message-attribution]"]
    })
  })
};

const DEEPSEEK_THINKING = ".ds-think-content, .ds-think, [class*='ds-think']";

function deepseekAnswerRoot(node) {
  return [...node.querySelectorAll(".ds-markdown, .ds-assistant-message-main-content")]
    .filter((item) => !item.closest(DEEPSEEK_THINKING))
    .at(-1) ?? null;
}

function deepseekMessages(doc) {
  const messages = [...doc.querySelectorAll(".ds-message")];
  return messages.length > 0 ? messages : [...doc.querySelectorAll("[data-virtual-list-item-key]")];
}

function isDeepseekAssistantMessage(node) {
  return Boolean(deepseekAnswerRoot(node) || node.querySelector(DEEPSEEK_THINKING));
}

function isDeepseekUserMessage(node) {
  if (isDeepseekAssistantMessage(node)) return false;
  // Prefer positive user markers so a pre-markdown assistant shell is not counted as a user turn.
  if (node.querySelector(".ds-collapsible-text")) return true;
  const text = node.innerText?.trim() ?? "";
  return text.length > 0 && !node.querySelector(".ds-loading, .ds-skeleton");
}

function isDeepseekSendButton(target, doc) {
  const button = target.closest?.("[role='button'], button");
  if (!button) return false;
  const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
  if (/停止|Stop|stop/i.test(label)) return false;
  if (/发送|Send|submit/i.test(label)) return true;
  const composer = doc.querySelector("textarea#chat-input, textarea[name='search'], textarea[placeholder*='DeepSeek'], textarea[placeholder*='发送']") ?? doc.querySelector("textarea");
  if (!composer) return false;
  // Primary circular button after the composer is the send control in the current UI.
  return button.classList.contains("ds-button--primary") && Boolean(composer.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export const deepseekAdapter = {
  platform: "deepseek",
  stableMs: 1_500,
  matches: ({ hostname }) => hostname === "chat.deepseek.com",
  getComposer: (doc) => doc.querySelector("textarea#chat-input, textarea[name='search'], textarea[placeholder*='DeepSeek'], textarea[placeholder*='发送']") ?? doc.querySelector("textarea"),
  getUserMessages: (doc) => deepseekMessages(doc).filter(isDeepseekUserMessage),
  getAssistantMessages: (doc) => deepseekMessages(doc).filter(isDeepseekAssistantMessage),
  isGenerating: (doc) => Boolean(doc.querySelector("[aria-label*='停止'], [aria-label*='Stop'], .ds-loading, .ds-button--loading")),
  isSendButton: (target, doc) => isDeepseekSendButton(target, doc),
  readComposer: (doc) => readEditable(deepseekAdapter.getComposer(doc)),
  readUserMessage: (node) => (node.querySelector(".ds-collapsible-text") ?? node).innerText.trim(),
  extractMessage: (node) => {
    const thinking = node.querySelector(DEEPSEEK_THINKING);
    const options = {
      removeSelectors: [".md-code-block-banner", ".md-code-block-banner-wrap", ".ds-flex .ds-button"],
      getCodeLanguage: (pre) => pre.closest(".md-code-block")?.querySelector(".md-code-block-infostring, .md-code-block-banner span")?.textContent?.trim() ?? ""
    };
    const answer = { role: "assistant", ...extractRichContent(deepseekAnswerRoot(node) ?? node, options) };
    if (thinking) {
      const reasoning = extractRichContent(thinking, options);
      answer.reasoning = { markdown: reasoning.markdown, plainText: reasoning.plainText };
    }
    return answer;
  }
};

export const CONVERSATION_ADAPTERS = [chatgptAdapter, deepseekAdapter];

export function resolveConversationAdapter(location, adapters = CONVERSATION_ADAPTERS) {
  return adapters.find((adapter) => adapter.matches(location)) ?? null;
}
