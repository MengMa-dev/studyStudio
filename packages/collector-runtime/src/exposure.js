/**
 * Content exposure (01): times block-level visibility inside the article root.
 * Reports section rollups + top blocks with page_session; AI conversation pages skip this.
 */
const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, pre, table, blockquote";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const CN_CHARS_PER_MIN = 400;
const EN_WORDS_PER_MIN = 200;
const IDLE_MS = 60_000;
const MIN_CONTINUOUS_MS = 1_000;

function normalizeFp(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 50);
}

function charStats(text) {
  const compact = text.replace(/\s+/g, "");
  const cjk = (compact.match(/[\u4e00-\u9fff]/g) ?? []).join("").length;
  const latin = compact.length - cjk;
  const words = Math.max(1, Math.round(latin / 5));
  return { chars: compact.length, cjk, words };
}

function expectedSeconds(text) {
  const { cjk, words } = charStats(text);
  return (cjk / CN_CHARS_PER_MIN + words / EN_WORDS_PER_MIN) * 60;
}

function nearestHeading(el) {
  let node = el;
  while (node) {
    let prev = node.previousElementSibling;
    while (prev) {
      if (prev.matches?.(HEADING_SELECTOR)) return prev;
      const nested = prev.querySelector?.(HEADING_SELECTOR);
      if (nested) {
        const headings = prev.querySelectorAll(HEADING_SELECTOR);
        return headings[headings.length - 1];
      }
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * @param {{ root: Element, doc?: Document, win?: Window }} options
 */
export function createExposureTracker({ root, doc = document, win = window }) {
  const blocks = new Map();
  let lastInteractionAt = Date.now();
  let focused = doc.hasFocus?.() !== false;
  let visible = doc.visibilityState === "visible";
  const listeners = new AbortController();
  const { signal } = listeners;
  let raf = 0;
  let lastTick = Date.now();

  const markInteraction = () => {
    lastInteractionAt = Date.now();
  };
  for (const type of ["scroll", "mousemove", "keydown", "pointerdown", "touchstart"]) {
    win.addEventListener(type, markInteraction, { passive: true, signal, capture: true });
  }
  doc.addEventListener(
    "visibilitychange",
    () => {
      visible = doc.visibilityState === "visible";
    },
    { signal }
  );
  win.addEventListener(
    "focus",
    () => {
      focused = true;
    },
    { signal }
  );
  win.addEventListener(
    "blur",
    () => {
      focused = false;
    },
    { signal }
  );

  const ensure = (el) => {
    if (blocks.has(el)) return blocks.get(el);
    const text = el.textContent ?? "";
    const entry = {
      el,
      fp: normalizeFp(text) || `block:${blocks.size}`,
      text,
      chars: charStats(text).chars,
      exposedMs: 0,
      continuousStart: null,
      intersecting: false,
      heading: nearestHeading(el)
    };
    blocks.set(el, entry);
    return entry;
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const block = ensure(entry.target);
        block.intersecting = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        if (!block.intersecting) {
          if (block.continuousStart !== null) {
            const span = Date.now() - block.continuousStart;
            if (span >= MIN_CONTINUOUS_MS) block.exposedMs += span;
            block.continuousStart = null;
          }
        }
      }
    },
    { threshold: 0.5 }
  );

  const watch = (el) => {
    if (!(el instanceof Element) || !root.contains(el)) return;
    if (!el.matches(BLOCK_SELECTOR)) return;
    ensure(el);
    observer.observe(el);
  };

  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) watch(el);

  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        watch(node);
        for (const child of node.querySelectorAll(BLOCK_SELECTOR)) watch(child);
      }
    }
  });
  mutations.observe(root, { childList: true, subtree: true });

  const tick = () => {
    const now = Date.now();
    const dt = now - lastTick;
    lastTick = now;
    const active = visible && focused && now - lastInteractionAt <= IDLE_MS;
    for (const block of blocks.values()) {
      if (active && block.intersecting) {
        if (block.continuousStart === null) block.continuousStart = now - Math.min(dt, MIN_CONTINUOUS_MS);
      } else if (block.continuousStart !== null) {
        const span = now - block.continuousStart;
        if (span >= MIN_CONTINUOUS_MS) block.exposedMs += span;
        block.continuousStart = null;
      }
    }
    raf = win.setTimeout(tick, 250);
  };
  raf = win.setTimeout(tick, 250);

  return {
    snapshot() {
      const now = Date.now();
      const list = [...blocks.values()].map((block) => {
        let exposedMs = block.exposedMs;
        if (block.continuousStart !== null) {
          const span = now - block.continuousStart;
          if (span >= MIN_CONTINUOUS_MS) exposedMs += span;
        }
        return { ...block, exposedSeconds: exposedMs / 1000 };
      });

      const sectionsMap = new Map();
      let untitledChunks = [];
      let untitledIndex = 0;
      const flushUntitled = () => {
        if (!untitledChunks.length) return;
        const key = `untitled:${untitledIndex++}`;
        const chars = untitledChunks.reduce((sum, item) => sum + item.chars, 0);
        const exposed = untitledChunks.reduce((sum, item) => sum + item.exposedSeconds, 0);
        const text = untitledChunks.map((item) => item.text).join("\n");
        sectionsMap.set(key, {
          key: `fp:${normalizeFp(text) || key}`,
          heading: null,
          chars,
          exposed_seconds: Number(exposed.toFixed(1)),
          coverage: Math.min(1, exposed / Math.max(1, expectedSeconds(text)))
        });
        untitledChunks = [];
      };

      for (const block of list) {
        const heading = block.heading;
        if (!heading) {
          untitledChunks.push(block);
          if (untitledChunks.length >= 5) flushUntitled();
          continue;
        }
        flushUntitled();
        const headingText = (heading.textContent ?? "").trim();
        const key = `fp:${normalizeFp(headingText) || "heading"}`;
        const current = sectionsMap.get(key) ?? {
          key,
          heading: headingText || null,
          chars: 0,
          exposed_seconds: 0,
          textParts: []
        };
        current.chars += block.chars;
        current.exposed_seconds += block.exposedSeconds;
        current.textParts.push(block.text);
        sectionsMap.set(key, current);
      }
      flushUntitled();

      const sections = [...sectionsMap.values()].slice(0, 100).map((section) => {
        const text = section.textParts?.join("\n") ?? "";
        const exposed = Number(section.exposed_seconds.toFixed(1));
        return {
          key: section.key,
          heading: section.heading,
          chars: section.chars,
          exposed_seconds: exposed,
          coverage: Number(Math.min(1, exposed / Math.max(1, expectedSeconds(text || "x".repeat(Math.max(1, section.chars))))).toFixed(3))
        };
      });

      const top_blocks = [...list]
        .filter((block) => block.exposedSeconds > 0 && block.fp)
        .sort((a, b) => b.exposedSeconds - a.exposedSeconds)
        .slice(0, 10)
        .map((block) => ({ fp: block.fp, exposed_seconds: Number(block.exposedSeconds.toFixed(1)) }));

      const totalChars = sections.reduce((sum, section) => sum + section.chars, 0) || 1;
      const covered = sections.reduce((sum, section) => sum + section.chars * section.coverage, 0);
      return {
        sections,
        top_blocks,
        page_coverage: Number(Math.min(1, covered / totalChars).toFixed(3))
      };
    },
    stop() {
      listeners.abort();
      observer.disconnect();
      mutations.disconnect();
      win.clearTimeout(raf);
    }
  };
}

/** Best-effort article root for exposure; mirrors the page extractor cascade without full extraction. */
export function findContentRoot(doc = document) {
  return doc.querySelector("article, main, [role='main']") ?? doc.body;
}
