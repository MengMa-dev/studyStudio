/* Browser-only, host-neutral collector runtime. No chrome/Electron/filesystem dependency. */
import { resolveConversationAdapter, CONVERSATION_ADAPTERS } from "./conversation-adapters.js";
import { extractPageContent } from "./page-extractor.js";
import { canonicalUrlOf, id, now } from "./util.js";

export { extractPageContent } from "./page-extractor.js";
export { extractRichContent, tableToMarkdown } from "./rich-content.js";
export { SITE_ADAPTERS, resolveSiteAdapter } from "./site-adapters.js";
export { CONVERSATION_ADAPTERS, chatgptAdapter, deepseekAdapter, resolveConversationAdapter } from "./conversation-adapters.js";
export { normalizeUrl, canonicalUrlOf, contentHash } from "./util.js";

/* Replaced by the build (`STUDY_STUDIO_DEV=1 npm run build:extension`); unbundled runs keep production thresholds. */
const DEV_MODE = typeof __STUDY_STUDIO_DEV__ !== "undefined" && __STUDY_STUDIO_DEV__ === true;

/** `minRevisitSeconds`: visible time a later stay on an already captured page needs to count as reading time. */
export const DEFAULT_THRESHOLD = DEV_MODE
  ? { minActiveSeconds: 5, minScrollDepth: 0, minRevisitSeconds: 3 }
  : { minActiveSeconds: 90, minScrollDepth: 0.35, minRevisitSeconds: 60 };

function event(type, fields) {
  return { id: id(), schemaVersion: 1, type, occurredAt: now(), ...fields };
}

/**
 * Tracks one page visit. Qualifying visits (reading threshold, note, copy/selection) emit a single
 * `webpage_captured`; pages already in the inbox are never captured again.
 * On close, `reading_session_closed` reports the visible time of the capturing stay, or of a later
 * stay on a captured page lasting at least `minRevisitSeconds`; other stays emit nothing.
 * `pageIndex.lookup(canonicalUrl)` is provided by the host and resolves to `{ captured }`.
 */
export function createPageCollector({ emit, channel, isStrongLearning = false, threshold: thresholdOverrides = DEFAULT_THRESHOLD, pageIndex = null, doc = document, win = window, checkIntervalMs = 5_000 }) {
  const threshold = { ...DEFAULT_THRESHOLD, ...thresholdOverrides };
  const sessionId = id();
  const openedAt = Date.now();
  const listeners = new AbortController();
  const { signal } = listeners;
  let activeStartedAt = doc.visibilityState === "visible" ? Date.now() : null;
  let activeMilliseconds = 0;
  let maxScrollDepth = 0;
  let interactionCount = 0;
  let lastSelection = "";
  let noteWritten = false;
  let captured = false;
  /** null while the host lookup is pending; a failed lookup counts as "not captured yet". */
  let previouslyCaptured = pageIndex ? null : false;
  let deferredReason = null;
  let stopped = false;
  const canonicalUrl = canonicalUrlOf(doc, win);
  const source = { channel, url: win.location.href, canonicalUrl, title: doc.title, isStrongLearning };

  const syncActive = () => {
    if (doc.visibilityState === "visible" && activeStartedAt === null) activeStartedAt = Date.now();
    if (doc.visibilityState !== "visible" && activeStartedAt !== null) {
      activeMilliseconds += Date.now() - activeStartedAt;
      activeStartedAt = null;
    }
  };
  const activeSeconds = () => Math.floor((activeMilliseconds + (activeStartedAt ? Date.now() - activeStartedAt : 0)) / 1000);
  const syncScroll = () => {
    const total = doc.documentElement.scrollHeight - win.innerHeight;
    const depth = total <= 0 ? 1 : win.scrollY / total;
    maxScrollDepth = Math.max(maxScrollDepth, Math.min(1, depth));
  };
  const signals = () => ({ isStrongLearning, activeDurationSeconds: activeSeconds(), maxScrollDepth: Number(maxScrollDepth.toFixed(3)), interactionCount, noteWritten });
  const qualifies = () => noteWritten || interactionCount > 0 || (maxScrollDepth >= threshold.minScrollDepth && activeSeconds() >= threshold.minActiveSeconds);
  const persistIfQualified = (reason) => {
    if (captured || previouslyCaptured || !qualifies()) return;
    if (previouslyCaptured === null) {
      deferredReason ??= reason;
      return;
    }
    const content = extractPageContent(doc);
    if (!content) return;
    captured = true;
    emit(event("webpage_captured", { source: { ...source, title: doc.title }, sessionId, reason, content, readingSignals: signals() }));
  };
  const onInteraction = (reason) => {
    interactionCount += 1;
    persistIfQualified(reason);
  };

  emit(event("page_opened", { source }));
  syncScroll();
  doc.addEventListener("visibilitychange", syncActive, { signal });
  win.addEventListener("scroll", syncScroll, { passive: true, signal });
  doc.addEventListener("copy", () => onInteraction("copy"), { signal });
  doc.addEventListener("mouseup", () => {
    const text = doc.getSelection()?.toString().trim() ?? "";
    if (text.length >= 2 && text !== lastSelection) {
      lastSelection = text;
      onInteraction("selection");
    }
  }, { signal });
  const interval = win.setInterval(() => persistIfQualified("threshold"), checkIntervalMs);

  if (pageIndex) {
    Promise.resolve()
      .then(() => pageIndex.lookup(canonicalUrl))
      .then((result) => result?.captured === true, () => false)
      .then((known) => {
        previouslyCaptured = known;
        if (!stopped && deferredReason) persistIfQualified(deferredReason);
      });
  }

  return {
    source,
    addNote(text) {
      noteWritten = true;
      emit(event("user_note", { source, note: { text }, context: { activeSourceUrl: win.location.href } }));
      persistIfQualified("note");
    },
    /** `capture: false` is used after SPA navigation, when the DOM already shows the next page. */
    stop({ capture = true } = {}) {
      if (stopped) return;
      syncActive();
      if (capture) {
        syncScroll();
        persistIfQualified("page_closed");
      }
      stopped = true;
      listeners.abort();
      win.clearInterval(interval);
      const readingTimeCounts = captured || (previouslyCaptured && activeSeconds() >= threshold.minRevisitSeconds);
      if (readingTimeCounts) emit(event("reading_session_closed", { source, sessionId, readingSignals: signals(), openedAt: new Date(openedAt).toISOString(), captured }));
    }
  };
}

/**
 * Emits `user_message_sent` when the user submits a question and `assistant_response_completed`
 * once the following answer stops changing. Existing history, regenerations and edits are ignored.
 */
export function createConversationCollector({ adapter, emit, channel, isStrongLearning = false, doc = document, win = window, debounceMs = 300 }) {
  const stableMs = adapter.stableMs ?? 1_500;
  const listeners = new AbortController();
  const { signal } = listeners;
  let armedText = "";
  let pending = null;
  let candidate = null;
  let userCount = adapter.getUserMessages(doc).length;
  let mutationTimer = null;
  let answerTimer = null;

  const source = () => ({ channel, platform: adapter.platform, url: win.location.href, title: doc.title, isStrongLearning });
  const isComposerTarget = (target) => {
    const composer = adapter.getComposer(doc);
    return Boolean(composer && target && (target === composer || composer.contains(target)));
  };
  const scheduleAnswerCheck = () => {
    win.clearTimeout(answerTimer);
    answerTimer = win.setTimeout(checkAnswer, stableMs);
  };

  const emitQuestion = (text, userCountBefore) => {
    if (!text || pending?.text === text) return;
    armedText = "";
    candidate = null;
    pending = { id: id(), text, occurredAt: now(), userCountBefore };
    emit({ id: pending.id, schemaVersion: 1, type: "user_message_sent", occurredAt: pending.occurredAt, source: source(), message: { role: "user", plainText: text, markdown: text } });
    scheduleAnswerCheck();
  };
  const emitFromComposer = () => emitQuestion(adapter.readComposer(doc), adapter.getUserMessages(doc).length);

  function checkAnswer() {
    if (!pending) return;
    if (adapter.isGenerating(doc)) return scheduleAnswerCheck();
    const users = adapter.getUserMessages(doc);
    const node = adapter.getAssistantMessages(doc).at(-1);
    const lastUser = users.at(-1);
    if (!node || !lastUser) return;
    // DeepSeek briefly mounts an assistant shell without markdown; that can inflate the
    // user-message count at emit time. Prefer matching the pending question text.
    const lastUserText = (adapter.readUserMessage?.(lastUser) || lastUser.innerText || "").trim();
    const questionMatched = lastUserText === pending.text || lastUserText.includes(pending.text) || pending.text.includes(lastUserText);
    if (!questionMatched && users.length <= pending.userCountBefore) return;
    if (!(lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    const answer = adapter.extractMessage(node);
    if (!answer.plainText) return;
    if (candidate !== answer.contentHash) {
      candidate = answer.contentHash;
      return scheduleAnswerCheck();
    }
    const question = pending;
    pending = null;
    candidate = null;
    emit(event("assistant_response_completed", {
      source: source(),
      replyTo: question.id,
      question: { id: question.id, plainText: question.text, occurredAt: question.occurredAt },
      answer
    }));
  }

  const onMutations = () => {
    const users = adapter.getUserMessages(doc);
    // Use the previous stable count — not users.length - 1 — so a transient misclassified
    // assistant shell cannot permanently block answer completion.
    if (users.length > userCount && armedText && !pending) {
      emitQuestion(adapter.readUserMessage?.(users.at(-1)) || armedText, userCount);
    }
    userCount = Math.max(userCount, users.length);
    // When a misclassified shell later becomes an assistant, the visible user count can drop.
    if (users.length < userCount && !pending) userCount = users.length;
    if (pending) scheduleAnswerCheck();
  };

  doc.addEventListener("input", (e) => { if (isComposerTarget(e.target)) armedText = adapter.readComposer(doc); }, { capture: true, signal });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && isComposerTarget(e.target)) emitFromComposer();
  }, { capture: true, signal });
  doc.addEventListener("click", (e) => { if (adapter.isSendButton?.(e.target, doc)) emitFromComposer(); }, { capture: true, signal });
  const observer = new MutationObserver(() => {
    win.clearTimeout(mutationTimer);
    mutationTimer = win.setTimeout(onMutations, debounceMs);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

  const openPage = () => emit(event("page_opened", { source: source() }));
  openPage();

  return {
    get source() { return source(); },
    navigated: openPage,
    addNote(text) {
      emit(event("user_note", { source: source(), note: { text }, context: { activeSourceUrl: win.location.href } }));
    },
    stop() {
      observer.disconnect();
      listeners.abort();
      win.clearTimeout(mutationTimer);
      win.clearTimeout(answerTimer);
    }
  };
}

/**
 * Host entry point: picks the conversation or page collector for the current URL and
 * follows SPA navigations. Hosts only provide `emit` and optionally `pageIndex`.
 */
export function installCollector({ emit, channel, isStrongLearning = false, threshold = DEFAULT_THRESHOLD, pageIndex = null, conversationAdapters = CONVERSATION_ADAPTERS, doc = document, win = window, navigationPollMs = 1_000, checkIntervalMs, debounceMs }) {
  let current = null;
  let mode = null;
  let href = win.location.href;

  const start = () => {
    const adapter = resolveConversationAdapter(win.location, conversationAdapters);
    mode = adapter ? adapter.platform : "page";
    current = adapter
      ? createConversationCollector({ adapter, emit, channel, isStrongLearning, doc, win, ...(debounceMs ? { debounceMs } : {}) })
      : createPageCollector({ emit, channel, isStrongLearning, threshold, pageIndex, doc, win, ...(checkIntervalMs ? { checkIntervalMs } : {}) });
  };
  const onNavigate = () => {
    if (win.location.href === href) return;
    href = win.location.href;
    const nextMode = resolveConversationAdapter(win.location, conversationAdapters)?.platform ?? "page";
    if (nextMode === mode && mode !== "page") return current.navigated();
    current?.stop({ capture: false });
    start();
  };

  start();
  const poll = win.setInterval(onNavigate, navigationPollMs);
  win.addEventListener("popstate", onNavigate);

  return {
    get mode() { return mode; },
    addNote: (text) => current?.addNote(text),
    stop() {
      win.clearInterval(poll);
      win.removeEventListener("popstate", onNavigate);
      current?.stop();
      current = null;
    }
  };
}