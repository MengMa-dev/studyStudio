import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvent, validateEvent } from "../src/index";

const source = { channel: "browser_extension" as const, url: "https://example.com/a", canonicalUrl: "https://example.com/a" };

test("createEvent fills envelope fields that pass validation", () => {
  const event = createEvent("user_note", { source, note: { text: "召回与重排的分工" } });
  assert.match(event.id, /^[\w-]{8,64}$/);
  assert.equal(validateEvent(event), null);
  assert.throws(() => createEvent("unknown" as never, {} as never));
});

test("validateEvent reports the first problem with its path", () => {
  assert.equal(validateEvent(null), "event must be an object");
  assert.equal(validateEvent({ type: "nope" }), "event.type is invalid");
  const note = createEvent("user_note", { source, note: { text: "x" } });
  assert.match(validateEvent({ ...note, note: { text: "" } }) ?? "", /^note\.text: /);
  assert.match(validateEvent({ ...note, id: "../../etc" }) ?? "", /^id: /);
  assert.match(validateEvent({ ...note, schemaVersion: 2 }) ?? "", /^schemaVersion: /);
  assert.match(validateEvent({ ...note, source: { channel: "unknown" } }) ?? "", /^source\.channel: /);
  const closed = createEvent("reading_session_closed", { source, readingSignals: { activeDurationSeconds: -1 } });
  assert.match(validateEvent(closed) ?? "", /^readingSignals\.activeDurationSeconds: /);
  assert.match(
    validateEvent({ ...closed, readingSignals: { activeDurationSeconds: 5 }, source: { channel: "browser_extension" } }) ?? "",
    /^source\.canonicalUrl: /
  );
});
