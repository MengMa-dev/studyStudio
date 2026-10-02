import assert from "node:assert/strict";
import { test } from "node:test";
import { applySegmentSuggestion, buildEpisodes, shouldRejudgeAfterSuggestion, type TimelineUnit } from "../../src/domains/organize/index.js";

const LEARNER = {
  role: "前端开发",
  learning_focus: [{ topic: "Agent 架构", expires_at: "2026-11-01" }]
};

function page(partial: Omit<Extract<TimelineUnit, { kind: "page_session" }>, "kind">): TimelineUnit {
  return { kind: "page_session", ...partial };
}

test("② stitches close learning pages and marks short distraction", () => {
  const units: TimelineUnit[] = [
    {
      kind: "search",
      id: "s1",
      occurredAt: "2026-10-02T12:00:00.000Z",
      engine: "google",
      query: "LangGraph checkpoint",
      tabId: 1
    },
    page({
      id: "p1",
      occurredAt: "2026-10-02T12:02:00.000Z",
      domain: "langchain-ai.github.io",
      category: "learning_candidate",
      url: "https://langchain-ai.github.io/langgraph/concepts/persistence/",
      title: "Persistence",
      referrer: "https://www.google.com/search?q=LangGraph+checkpoint",
      tabId: 1,
      startedAt: "2026-10-02T12:02:00.000Z",
      endedAt: "2026-10-02T12:09:00.000Z",
      visibleSeconds: 420,
      maxScrollDepth: 0.8,
      itemId: "item_A"
    }),
    page({
      id: "p2",
      occurredAt: "2026-10-02T12:10:00.000Z",
      domain: "weibo.com",
      category: "unrelated",
      tabId: 2,
      startedAt: "2026-10-02T12:10:00.000Z",
      endedAt: "2026-10-02T12:14:00.000Z",
      visibleSeconds: 240
    }),
    page({
      id: "p3",
      occurredAt: "2026-10-02T12:15:00.000Z",
      domain: "langchain-ai.github.io",
      category: "learning_candidate",
      url: "https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/",
      title: "Human-in-the-loop",
      tabId: 1,
      startedAt: "2026-10-02T12:15:00.000Z",
      endedAt: "2026-10-02T12:23:00.000Z",
      visibleSeconds: 480,
      itemId: "item_C"
    })
  ];

  const { episodes, deferredOpen } = buildEpisodes({
    units,
    learnerProfile: LEARNER,
    recentKbTopics: ["LangGraph"],
    now: "2026-10-02T14:00:00.000Z",
    episodeIdFor: () => "ep_test"
  });

  assert.equal(deferredOpen.length, 0);
  assert.equal(episodes.length, 1);
  const ep = episodes[0]!;
  assert.equal(ep.status, "ready");
  assert.ok(ep.itemIds.includes("item_A"));
  assert.ok(ep.itemIds.includes("item_C"));
  assert.equal(ep.flags.includes("long_distraction"), false);
  assert.ok(ep.judgeInput.timeline.some((e) => e.kind === "distraction"));
  assert.ok(ep.judgeInput.timeline.some((e) => e.kind === "search"));
  assert.equal(ep.judgeInput.learner_profile.role, "前端开发");
});

test("② hard-splits on ≥ hardGapMinutes idle gap", () => {
  const units: TimelineUnit[] = [
    page({
      id: "a",
      occurredAt: "2026-10-02T08:00:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T08:00:00.000Z",
      endedAt: "2026-10-02T08:20:00.000Z",
      visibleSeconds: 1200,
      itemId: "item_1"
    }),
    page({
      id: "b",
      occurredAt: "2026-10-02T09:00:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T09:00:00.000Z",
      endedAt: "2026-10-02T09:15:00.000Z",
      visibleSeconds: 900,
      itemId: "item_2"
    })
  ];
  const { episodes } = buildEpisodes({
    units,
    learnerProfile: LEARNER,
    now: "2026-10-02T12:00:00.000Z"
  });
  assert.equal(episodes.length, 2);
});

test("② stitches same AI conversation across a moderate gap", () => {
  const units: TimelineUnit[] = [
    {
      kind: "ai_turn",
      id: "t1",
      occurredAt: "2026-10-02T10:00:00.000Z",
      conversationId: "c1",
      platform: "chatgpt",
      question: "checkpoint 是什么",
      turnIndex: 1,
      itemId: "item_B"
    },
    {
      kind: "ai_turn",
      id: "t2",
      occurredAt: "2026-10-02T10:25:00.000Z",
      conversationId: "c1",
      platform: "chatgpt",
      question: "interrupt 呢",
      turnIndex: 2
    }
  ];
  const { episodes } = buildEpisodes({
    units,
    learnerProfile: LEARNER,
    now: "2026-10-02T12:00:00.000Z"
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0]!.units.length, 2);
});

test("② prefilters all-unrelated and too-short; defers open on auto", () => {
  const unrelated: TimelineUnit[] = [
    page({
      id: "u1",
      occurredAt: "2026-10-02T11:00:00.000Z",
      domain: "weibo.com",
      category: "unrelated",
      startedAt: "2026-10-02T11:00:00.000Z",
      endedAt: "2026-10-02T11:05:00.000Z",
      visibleSeconds: 300
    })
  ];
  const { episodes: ep1 } = buildEpisodes({
    units: unrelated,
    learnerProfile: LEARNER,
    now: "2026-10-02T14:00:00.000Z"
  });
  assert.equal(ep1[0]?.status, "prefiltered");
  assert.equal(ep1[0]?.prefilterReason, "all_unrelated");

  const short: TimelineUnit[] = [
    page({
      id: "n1",
      occurredAt: "2026-10-02T11:00:00.000Z",
      domain: "example.com",
      category: "neutral",
      startedAt: "2026-10-02T11:00:00.000Z",
      endedAt: "2026-10-02T11:00:30.000Z",
      visibleSeconds: 30
    })
  ];
  const { episodes: ep2 } = buildEpisodes({
    units: short,
    learnerProfile: LEARNER,
    now: "2026-10-02T14:00:00.000Z"
  });
  assert.equal(ep2[0]?.status, "prefiltered");
  assert.equal(ep2[0]?.prefilterReason, "too_short");

  const recent: TimelineUnit[] = [
    page({
      id: "r1",
      occurredAt: "2026-10-02T13:50:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T13:50:00.000Z",
      endedAt: "2026-10-02T13:55:00.000Z",
      visibleSeconds: 300,
      itemId: "item_r"
    })
  ];
  const auto = buildEpisodes({
    units: recent,
    learnerProfile: LEARNER,
    now: "2026-10-02T14:00:00.000Z",
    isManual: false
  });
  assert.equal(auto.deferredOpen.length, 1);
  assert.equal(auto.deferredOpen[0]?.status, "open");

  const manual = buildEpisodes({
    units: recent,
    learnerProfile: LEARNER,
    now: "2026-10-02T14:00:00.000Z",
    isManual: true
  });
  assert.equal(manual.deferredOpen.length, 0);
  assert.equal(manual.episodes[0]?.status, "ready");
});

test("② long distraction flag when unrelated 15–30 min then return", () => {
  const units: TimelineUnit[] = [
    page({
      id: "l1",
      occurredAt: "2026-10-02T12:00:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T12:00:00.000Z",
      endedAt: "2026-10-02T12:10:00.000Z",
      visibleSeconds: 600,
      itemId: "item_x"
    }),
    page({
      id: "l2",
      occurredAt: "2026-10-02T12:11:00.000Z",
      domain: "bilibili.com",
      category: "unrelated",
      startedAt: "2026-10-02T12:11:00.000Z",
      endedAt: "2026-10-02T12:28:00.000Z",
      visibleSeconds: 1020
    }),
    page({
      id: "l3",
      occurredAt: "2026-10-02T12:29:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T12:29:00.000Z",
      endedAt: "2026-10-02T12:40:00.000Z",
      visibleSeconds: 660,
      itemId: "item_y"
    })
  ];
  const { episodes } = buildEpisodes({
    units,
    learnerProfile: LEARNER,
    now: "2026-10-02T15:00:00.000Z"
  });
  assert.equal(episodes.length, 1);
  assert.ok(episodes[0]!.flags.includes("long_distraction"));
});

test("segment_suggestion split applies at most one round", () => {
  const units: TimelineUnit[] = [
    page({
      id: "a",
      occurredAt: "2026-10-02T12:00:00.000Z",
      domain: "react.dev",
      category: "learning_candidate",
      startedAt: "2026-10-02T12:00:00.000Z",
      endedAt: "2026-10-02T12:10:00.000Z",
      visibleSeconds: 600,
      itemId: "i1"
    }),
    page({
      id: "b",
      occurredAt: "2026-10-02T12:12:00.000Z",
      domain: "vuejs.org",
      category: "learning_candidate",
      startedAt: "2026-10-02T12:12:00.000Z",
      endedAt: "2026-10-02T12:20:00.000Z",
      visibleSeconds: 480,
      itemId: "i2"
    })
  ];
  const { episodes } = buildEpisodes({
    units,
    learnerProfile: LEARNER,
    now: "2026-10-02T15:00:00.000Z",
    episodeIdFor: () => "ep_one"
  });
  assert.equal(shouldRejudgeAfterSuggestion({ action: "split", at: "12:12" }, false), true);
  const once = applySegmentSuggestion(episodes, "ep_one", { action: "split", at: "12:12" }, false);
  assert.equal(once.applied, true);
  assert.equal(once.episodes.length, 2);
  const twice = applySegmentSuggestion(once.episodes, once.episodes[0]!.episodeId, { action: "split", at: "12:00" }, true);
  assert.equal(twice.applied, false);
  assert.equal(twice.reason, "already_corrected_once");
});
