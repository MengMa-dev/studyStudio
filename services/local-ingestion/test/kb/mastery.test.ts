import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_MASTERY_SIGNALS, MASTERY_K, effectiveMastery, estimateMastery, saturate } from "../../src/domains/kb/mastery.js";

test("saturate: 0 for non-positive, ≈0.632 at x=k, approaches 1", () => {
  assert.equal(saturate(0, 3), 0);
  assert.equal(saturate(-5, 3), 0);
  assert.ok(Math.abs(saturate(3, 3) - (1 - Math.exp(-1))) < 1e-9);
  assert.ok(saturate(1e6, 3) > 0.999);
});

test("estimateMastery keeps previous value without sources", () => {
  assert.equal(estimateMastery(EMPTY_MASTERY_SIGNALS, null), null);
  assert.equal(estimateMastery({ ...EMPTY_MASTERY_SIGNALS, readingSeconds: 9999 }, 0.42), 0.42);
  assert.equal(estimateMastery(EMPTY_MASTERY_SIGNALS, 1.7), 1);
});

test("estimateMastery follows 0.35/0.35/0.2/0.1 weights and stays in [0,1]", () => {
  const atK = estimateMastery(
    { sourceCount: MASTERY_K.sources, readingSeconds: MASTERY_K.readingSeconds, qaCount: MASTERY_K.qa, noteCount: MASTERY_K.notes },
    null
  );
  assert.equal(atK, Math.round((1 - Math.exp(-1)) * 1000) / 1000);

  const onlySource = estimateMastery({ sourceCount: 1, readingSeconds: 0, qaCount: 0, noteCount: 0 }, 0.9)!;
  assert.ok(Math.abs(onlySource - 0.35 * (1 - Math.exp(-1 / 3))) < 0.001);

  const huge = estimateMastery({ sourceCount: 1e6, readingSeconds: 1e9, qaCount: 1e6, noteCount: 1e6 }, null)!;
  assert.equal(huge, 1);

  const more = estimateMastery({ sourceCount: 2, readingSeconds: 600, qaCount: 1, noteCount: 0 }, null)!;
  const less = estimateMastery({ sourceCount: 2, readingSeconds: 60, qaCount: 1, noteCount: 0 }, null)!;
  assert.ok(more > less);
});

test("effectiveMastery: user value wins; auto re-estimates", () => {
  const signals = { sourceCount: 3, readingSeconds: 1800, qaCount: 0, noteCount: 0 };
  assert.equal(effectiveMastery(0.9, "user", signals), 0.9);
  assert.equal(effectiveMastery(null, "user", signals), null);
  assert.notEqual(effectiveMastery(0.9, "auto", signals), 0.9);
  assert.equal(effectiveMastery(0.9, null, signals), estimateMastery(signals, 0.9));
});
