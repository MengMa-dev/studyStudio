import { createHash, randomUUID } from "node:crypto";

export const EVENT_TYPES = new Set([
  "page_opened",
  "webpage_captured",
  "reading_session_closed",
  "user_message_sent",
  "assistant_response_completed",
  "user_note",
  "source_excluded"
]);

export const SOURCE_CHANNELS = new Set(["browser_extension", "desktop_browser"]);

export function createEvent(type, payload) {
  if (!EVENT_TYPES.has(type)) throw new Error(`Unsupported collector event: ${type}`);
  return {
    id: randomUUID(),
    schemaVersion: 1,
    type,
    occurredAt: new Date().toISOString(),
    ...payload
  };
}

export function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const isText = (value) => typeof value === "string" && value.trim().length > 0;

const PAYLOAD_RULES = {
  user_message_sent: (event) => isText(event.message?.plainText) || "message.plainText is required",
  assistant_response_completed: (event) => isText(event.answer?.plainText) || "answer.plainText is required",
  webpage_captured: (event) => {
    if (!isText(event.content?.plainText)) return "content.plainText is required";
    if (!isText(event.content?.canonicalUrl)) return "content.canonicalUrl is required";
    return true;
  },
  user_note: (event) => isText(event.note?.text) || "note.text is required",
  reading_session_closed: (event) => {
    if (!isText(event.source?.canonicalUrl)) return "source.canonicalUrl is required";
    const seconds = event.readingSignals?.activeDurationSeconds;
    return (Number.isFinite(seconds) && seconds >= 0) || "readingSignals.activeDurationSeconds is invalid";
  }
};

export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "event must be an object";
  if (!EVENT_TYPES.has(event.type)) return "event.type is invalid";
  if (event.schemaVersion !== 1) return "unsupported schemaVersion";
  if (!isText(event.id) || !/^[\w-]{8,64}$/.test(event.id)) return "event.id is invalid";
  if (!isText(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) return "event.occurredAt is invalid";
  if (!event.source || !SOURCE_CHANNELS.has(event.source.channel)) return "event.source.channel is invalid";
  const rule = PAYLOAD_RULES[event.type];
  const result = rule ? rule(event) : true;
  return result === true ? null : result;
}
