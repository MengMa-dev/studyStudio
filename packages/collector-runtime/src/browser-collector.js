import { resolveConversationAdapter, CONVERSATION_ADAPTERS } from "./conversation-adapters.js";
import { extractPageContent } from "./page-extractor.js";
import { createExposureTracker, findContentRoot } from "./exposure.js";
import { canonicalUrlOf, id, now } from "./util.js";

export { extractPageContent } from "./page-extractor.js";
export { extractRichContent, tableToMarkdown } from "./rich-content.js";
export { SITE_ADAPTERS, resolveSiteAdapter } from "./site-adapters.js";
export { CONVERSATION_ADAPTERS, chatgptAdapter, deepseekAdapter, resolveConversationAdapter } from "./conversation-adapters.js";
export { normalizeUrl, canonicalUrlOf, contentHash } from "./util.js";
export { createExposureTracker, findContentRoot } from "./exposure.js";

/* Desktop inject still defines this; extension uses dynamic settings instead. */
const DEV_MODE = typeof __STUDY_STUDIO_DEV__ !== "undefined" && __STUDY_STUDIO_DEV__ === true;

/** `minRevisitSeconds`: visible time a later stay on an already captured page needs to count as reading time. */
export const DEFAULT_THRESHOLD = DEV_MODE
  ? { minActiveSeconds: 5, minScrollDepth: 0, minRevisitSeconds: 3 }
  : { minActiveSeconds: 90, minScrollDepth: 0.35, minRevisitSeconds: 60 };

const MAX_SNIPPET = 500;
const PRESENCE_INTERVAL_MS = 15_000;
const SESSION_AWAY_MS = 30 * 60 * 1000;

function event(type, fields) {
  return { id: id(), schemaVersion: 1, type, occurredAt: now(), ...fields };
}

function snippetFromSelection(doc) {
  const selection = doc.getSelection?.();
  const text = selection?.toString()?.trim() ?? "";
  if (text.length < 2) return null;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const isCode = Boolean(anchor?.closest?.("pre, code"));
  return { text: text.slice(0, MAX_SNIPPET), isCode };
}

export function conversationIdFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === "chatgpt.com" || hostname === "chat.openai.com") {
      const match = pathname.match(/\/(?:c|g|uc)\/([^/?#]+)/);
      return match?.[1] ?? null;
    }
    if (hostname === "chat.deepseek.com") {
      const match = pathname.match(/\/a\/chat\/s\/([^/?#]+)/);
      return match?.[1] ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}

function isCodeSelection(doc) {
  const selection = doc.getSelection?.();
  const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
  return Boolean(anchor?.closest?.("pre, code"));
}

/**
 * Tracks one page visit. Qualifying visits emit `webpage_captured`; every visit emits `page_session`
 * on close (privacy-stripped for `unrelated`). Behaviour events stay metadata-only.
 */
export function createPageCollector({
  emit,
  channel,
  isStrongLearning = false,
  threshold: thresholdOverrides = DEFAULT_THRESHOLD,
  pageIndex = null,
  doc = document,
  win = window,
  checkIntervalMs = 5_000,
  activityEnabled = false,
  category = "neutral",
  tabId = null,
  navigation = null,
  captureHints = null,
  onPresence = null,
  excluded = false
}) {
  if (excluded) {
    return {
      source: { channel, url: win.location.href },
      addNote() {},
      stop() {}
    };
  }

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
  let lastVisibleAt = Date.now();
  const canonicalUrl = canonicalUrlOf(doc, win);
  const domain = (() => {
    try {
      return new URL(win.location.href).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const unrelated = category === "unrelated";
  const source = unrelated ? { channel, isStrongLearning } : { channel, url: win.location.href, canonicalUrl, title: doc.title, isStrongLearning };

  const exposure = activityEnabled && !unrelated ? createExposureTracker({ root: findContentRoot(doc), doc, win }) : null;

  const syncActive = () => {
    if (doc.visibilityState === "visible" && activeStartedAt === null) {
      activeStartedAt = Date.now();
      lastVisibleAt = Date.now();
    }
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
  const signals = () => ({
    isStrongLearning,
    activeDurationSeconds: activeSeconds(),
    maxScrollDepth: Number(maxScrollDepth.toFixed(3)),
    interactionCount,
    noteWritten
  });
  const forceCapture = () => Boolean(captureHints?.fromSearch || captureHints?.nearAiConversation);
  const qualifies = () =>
    noteWritten || interactionCount > 0 || forceCapture() || (maxScrollDepth >= threshold.minScrollDepth && activeSeconds() >= threshold.minActiveSeconds);
  const persistIfQualified = (reason) => {
    if (unrelated || captured || previouslyCaptured || !qualifies()) return;
    if (previouslyCaptured === null) {
      deferredReason ??= reason;
      return;
    }
    const content = extractPageContent(doc);
    if (!content) return;
    captured = true;
    emit(
      event("webpage_captured", {
        source: { ...source, title: doc.title, url: win.location.href, canonicalUrl },
        sessionId,
        reason,
        content,
        readingSignals: signals()
      })
    );
  };
  const onInteraction = (reason) => {
    interactionCount += 1;
    persistIfQualified(reason);
  };
  const emitSnippet = (type, text, isCode) => {
    if (!activityEnabled || unrelated || text.length < 2) return;
    emit(
      event(type, {
        source: { channel, url: win.location.href, canonicalUrl, title: doc.title, isStrongLearning },
        snippet: { text: text.slice(0, MAX_SNIPPET), isCode }
      })
    );
  };

  if (!unrelated) emit(event("page_opened", { source }));
  syncScroll();
  doc.addEventListener("visibilitychange", syncActive, { signal });
  win.addEventListener("scroll", syncScroll, { passive: true, signal });
  doc.addEventListener(
    "copy",
    () => {
      const selected = doc.getSelection()?.toString().trim() || "";
      if (selected) emitSnippet("copy", selected, isCodeSelection(doc));
      onInteraction("copy");
    },
    { signal }
  );
  doc.addEventListener(
    "mouseup",
    () => {
      const snippet = snippetFromSelection(doc);
      if (snippet && snippet.text !== lastSelection) {
        lastSelection = snippet.text;
        emitSnippet("selection", snippet.text, snippet.isCode);
        onInteraction("selection");
      }
    },
    { signal }
  );
  const interval = win.setInterval(() => {
    persistIfQualified("threshold");
    if (doc.visibilityState === "visible") lastVisibleAt = Date.now();
    else if (Date.now() - lastVisibleAt >= SESSION_AWAY_MS) stopCollector({ capture: true, away: true });
  }, checkIntervalMs);

  let presenceTimer = null;
  if (onPresence && !unrelated) {
    const beat = () => {
      if (doc.visibilityState !== "visible") return;
      onPresence({
        title: doc.title,
        url: win.location.href,
        visibleSeconds: activeSeconds(),
        captured: captured || previouslyCaptured === true
      });
    };
    presenceTimer = win.setInterval(beat, PRESENCE_INTERVAL_MS);
    beat();
  }

  if (pageIndex) {
    Promise.resolve()
      .then(() => pageIndex.lookup(canonicalUrl))
      .then(
        (result) => result?.captured === true,
        () => false
      )
      .then((known) => {
        previouslyCaptured = known;
        if (!stopped && deferredReason) persistIfQualified(deferredReason);
      });
  }

  function emitPageSession(endedAt = Date.now()) {
    if (!activityEnabled) return;
    const session = {
      tabId: tabId ?? undefined,
      openerTabId: navigation?.openerTabId,
      domain,
      category,
      startedAt: new Date(openedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      visibleSeconds: activeSeconds(),
      maxScrollDepth: Number(maxScrollDepth.toFixed(3)),
      revisit: previouslyCaptured === true,
      captured
    };
    if (!unrelated) {
      session.url = win.location.href;
      session.title = doc.title;
      session.h1 = doc.querySelector("h1")?.textContent?.trim() || undefined;
      session.metaDescription = doc.querySelector("meta[name='description']")?.content?.trim() || undefined;
      session.referrer = navigation?.referrer || doc.referrer || undefined;
      session.transition = navigation?.transition;
      const exposureSnapshot = exposure?.snapshot();
      if (exposureSnapshot) session.exposure = exposureSnapshot;
    }
    emit(event("page_session", { source: unrelated ? { channel } : source, session }));
  }

  function stopCollector({ capture = true, away = false } = {}) {
    if (stopped) return;
    syncActive();
    if (capture) {
      syncScroll();
      persistIfQualified(away ? "away" : "page_closed");
    }
    stopped = true;
    listeners.abort();
    win.clearInterval(interval);
    if (presenceTimer) win.clearInterval(presenceTimer);
    exposure?.stop();
    emitPageSession();
    const readingTimeCounts = !unrelated && (captured || (previouslyCaptured && activeSeconds() >= threshold.minRevisitSeconds));
    if (readingTimeCounts)
      emit(event("reading_session_closed", { source, sessionId, readingSignals: signals(), openedAt: new Date(openedAt).toISOString(), captured }));
  }

  return {
    source,
    addNote(text) {
      if (unrelated) return;
      noteWritten = true;
      emit(event("user_note", { source, note: { text }, context: { activeSourceUrl: win.location.href } }));
      persistIfQualified("note");
    },
    /** `capture: false` is used after SPA navigation, when the DOM already shows the next page. */
    stop(options) {
      stopCollector(options);
    }
  };
}

/**
 * Emits `user_message_sent` when the user submits a question and `assistant_response_completed`
 * once the following answer stops changing. Existing history, regenerations and edits are ignored.
 */
export function createConversationCollector({
  adapter,
  emit,
  channel,
  isStrongLearning = false,
  doc = document,
  win = window,
  debounceMs = 300,
  onPresence = null
}) {
  const stableMs = adapter.stableMs ?? 1_500;
  const listeners = new AbortController();
  const { signal } = listeners;
  let armedText = "";
  let pending = null;
  let candidate = null;
  let userCount = adapter.getUserMessages(doc).length;
  let mutationTimer = null;
  let answerTimer = null;
  let activeStartedAt = doc.visibilityState === "visible" ? Date.now() : null;
  let activeMilliseconds = 0;

  const conversationId = () => conversationIdFromUrl(win.location.href) ?? undefined;
  const source = () => ({ channel, platform: adapter.platform, url: win.location.href, title: doc.title, isStrongLearning });
  const isComposerTarget = (target) => {
    const composer = adapter.getComposer(doc);
    return Boolean(composer && target && (target === composer || composer.contains(target)));
  };
  const scheduleAnswerCheck = () => {
    win.clearTimeout(answerTimer);
    answerTimer = win.setTimeout(checkAnswer, stableMs);
  };
  const syncActive = () => {
    if (doc.visibilityState === "visible" && activeStartedAt === null) activeStartedAt = Date.now();
    if (doc.visibilityState !== "visible" && activeStartedAt !== null) {
      activeMilliseconds += Date.now() - activeStartedAt;
      activeStartedAt = null;
    }
  };
  const activeSeconds = () => Math.floor((activeMilliseconds + (activeStartedAt ? Date.now() - activeStartedAt : 0)) / 1000);
  doc.addEventListener("visibilitychange", syncActive, { signal });

  const emitQuestion = (text, userCountBefore) => {
    if (!text || pending?.text === text) return;
    armedText = "";
    candidate = null;
    pending = { id: id(), text, occurredAt: now(), userCountBefore };
    emit({
      id: pending.id,
      schemaVersion: 1,
      type: "user_message_sent",
      occurredAt: pending.occurredAt,
      source: source(),
      conversationId: conversationId(),
      message: { role: "user", plainText: text, markdown: text }
    });
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
    emit(
      event("assistant_response_completed", {
        source: source(),
        conversationId: conversationId(),
        replyTo: question.id,
        question: { id: question.id, plainText: question.text, occurredAt: question.occurredAt },
        answer
      })
    );
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

  doc.addEventListener(
    "input",
    (e) => {
      if (isComposerTarget(e.target)) armedText = adapter.readComposer(doc);
    },
    { capture: true, signal }
  );
  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && isComposerTarget(e.target)) emitFromComposer();
    },
    { capture: true, signal }
  );
  doc.addEventListener(
    "click",
    (e) => {
      if (adapter.isSendButton?.(e.target, doc)) emitFromComposer();
    },
    { capture: true, signal }
  );
  const observer = new MutationObserver(() => {
    win.clearTimeout(mutationTimer);
    mutationTimer = win.setTimeout(onMutations, debounceMs);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

  const openPage = () => emit(event("page_opened", { source: source() }));
  openPage();

  let presenceTimer = null;
  if (onPresence) {
    const beat = () => {
      if (doc.visibilityState !== "visible") return;
      syncActive();
      onPresence({
        title: doc.title,
        url: win.location.href,
        visibleSeconds: activeSeconds(),
        captured: true,
        platform: adapter.platform
      });
    };
    presenceTimer = win.setInterval(beat, PRESENCE_INTERVAL_MS);
    beat();
  }

  return {
    get source() {
      return source();
    },
    navigated: openPage,
    addNote(text) {
      emit(event("user_note", { source: source(), note: { text }, context: { activeSourceUrl: win.location.href } }));
    },
    stop() {
      observer.disconnect();
      listeners.abort();
      win.clearTimeout(mutationTimer);
      win.clearTimeout(answerTimer);
      if (presenceTimer) win.clearInterval(presenceTimer);
    }
  };
}

/**
 * Host entry point: picks the conversation or page collector for the current URL and
 * follows SPA navigations. Hosts only provide `emit` and optionally `pageIndex`.
 */
export function installCollector({
  emit,
  channel,
  isStrongLearning = false,
  threshold = DEFAULT_THRESHOLD,
  pageIndex = null,
  conversationAdapters = CONVERSATION_ADAPTERS,
  doc = document,
  win = window,
  navigationPollMs = 1_000,
  checkIntervalMs,
  debounceMs,
  activityEnabled = false,
  category = "neutral",
  tabId = null,
  navigation = null,
  captureHints = null,
  onPresence = null,
  excluded = false,
  conversationPlatforms = null,
  onSearch = null
}) {
  let current = null;
  let mode = null;
  let href = win.location.href;

  const adapters = conversationAdapters.filter((adapter) => {
    if (!conversationPlatforms) return true;
    return conversationPlatforms[adapter.platform] !== false;
  });

  const maybeSearch = () => {
    if (!activityEnabled || !onSearch || excluded || category === "unrelated") return;
    onSearch(win.location.href);
  };

  const start = () => {
    const adapter = resolveConversationAdapter(win.location, adapters);
    mode = adapter ? adapter.platform : "page";
    maybeSearch();
    current = adapter
      ? createConversationCollector({
          adapter,
          emit,
          channel,
          isStrongLearning,
          doc,
          win,
          onPresence,
          ...(debounceMs ? { debounceMs } : {})
        })
      : createPageCollector({
          emit,
          channel,
          isStrongLearning,
          threshold,
          pageIndex,
          doc,
          win,
          activityEnabled,
          category,
          tabId,
          navigation,
          captureHints,
          onPresence,
          excluded,
          ...(checkIntervalMs ? { checkIntervalMs } : {})
        });
  };
  const onNavigate = () => {
    if (win.location.href === href) return;
    href = win.location.href;
    const nextMode = resolveConversationAdapter(win.location, adapters)?.platform ?? "page";
    if (nextMode === mode && mode !== "page") return current.navigated();
    current?.stop({ capture: false });
    start();
  };

  start();
  const poll = win.setInterval(onNavigate, navigationPollMs);
  win.addEventListener("popstate", onNavigate);

  return {
    get mode() {
      return mode;
    },
    addNote: (text) => current?.addNote(text),
    stop() {
      win.clearInterval(poll);
      win.removeEventListener("popstate", onNavigate);
      current?.stop();
      current = null;
    }
  };
}
