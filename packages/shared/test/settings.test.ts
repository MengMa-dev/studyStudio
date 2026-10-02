import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACTIVITY_TRACKING,
  DEFAULT_CAPTURE_RULES,
  DEFAULT_CONVERSATION_PLATFORMS,
  DEFAULT_LEARNER_PROFILE,
  DEFAULT_ORGANIZE_SETTINGS,
  activeDirections,
  activityTrackingSchema,
  applyCaptureRulesUpdate,
  captureRulesSchema,
  collectorSettingsUpdateSchema,
  conversationPlatformsSchema,
  learnerProfileSchema,
  organizeSettingsSchema
} from "../src/index";

test("defaults satisfy their schemas", () => {
  assert.equal(captureRulesSchema.safeParse(DEFAULT_CAPTURE_RULES).success, true);
  assert.equal(activityTrackingSchema.safeParse(DEFAULT_ACTIVITY_TRACKING).success, true);
  assert.equal(conversationPlatformsSchema.safeParse(DEFAULT_CONVERSATION_PLATFORMS).success, true);
  assert.equal(organizeSettingsSchema.safeParse(DEFAULT_ORGANIZE_SETTINGS).success, true);
  assert.equal(learnerProfileSchema.safeParse(DEFAULT_LEARNER_PROFILE).success, true);
});

test("auto organize defaults: daily 23:00 and every 10 items on, organize on ingest off", () => {
  assert.deepEqual(DEFAULT_ORGANIZE_SETTINGS.triggers, {
    daily: { enabled: true, time: "23:00" },
    batch: { enabled: true, count: 10 },
    onIngest: { enabled: false }
  });
  assert.equal(
    organizeSettingsSchema.safeParse({
      ...DEFAULT_ORGANIZE_SETTINGS,
      triggers: { ...DEFAULT_ORGANIZE_SETTINGS.triggers, daily: { enabled: true, time: "24:00" } }
    }).success,
    false
  );
});

test("capture presets replace the build-time STUDY_STUDIO_DEV switch", () => {
  const debug = applyCaptureRulesUpdate(DEFAULT_CAPTURE_RULES, { preset: "debug" });
  assert.deepEqual([debug.minActiveSeconds, debug.minScrollDepth, debug.minRevisitSeconds], [5, 0, 3]);
  assert.equal(applyCaptureRulesUpdate(debug, { minActiveSeconds: 30 }).preset, "custom");
  assert.equal(applyCaptureRulesUpdate(DEFAULT_CAPTURE_RULES, { captureFromSearch: false }).preset, "standard");
});

test("unrelated domains are normalised and validated", () => {
  const parsed = collectorSettingsUpdateSchema.parse({ activityTracking: { unrelatedDomains: [" Weibo.COM "] } });
  assert.deepEqual(parsed.activityTracking?.unrelatedDomains, ["weibo.com"]);
  assert.equal(collectorSettingsUpdateSchema.safeParse({ activityTracking: { unrelatedDomains: ["not a domain"] } }).success, false);
});

test("expired learning directions no longer apply", () => {
  const profile = learnerProfileSchema.parse({
    role: "前端开发",
    directions: [
      { id: "d1", text: "Agent 架构", expiresAt: "2026-11-02" },
      { id: "d2", text: "RAG", expiresAt: "2026-10-01" }
    ]
  });
  assert.deepEqual(
    activeDirections(profile, "2026-10-03").map((direction) => direction.text),
    ["Agent 架构"]
  );
});
