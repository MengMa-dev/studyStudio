import { EVENT_SCHEMAS, SCHEMA_VERSION, isEventType, type CollectorEvent, type EventOf, type EventType } from "@study-studio/shared";

export { EVENT_TYPES, SOURCE_CHANNELS, isEventType } from "@study-studio/shared";
export type { CollectorEvent, EventType } from "@study-studio/shared";

type Payload<T extends EventType> = Omit<EventOf<T>, "id" | "schemaVersion" | "type" | "occurredAt">;

export function createEvent<T extends EventType>(type: T, payload: Payload<T>): EventOf<T> {
  if (!isEventType(type)) throw new Error(`Unsupported collector event: ${String(type)}`);
  return { id: crypto.randomUUID(), schemaVersion: SCHEMA_VERSION, type, occurredAt: new Date().toISOString(), ...payload } as EventOf<T>;
}

/** Returns `null` for a valid event, otherwise the first problem as `path: message`. */
export function validateEvent(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return "event must be an object";
  const { type } = event as { type?: unknown };
  if (!isEventType(type)) return "event.type is invalid";
  const result = EVENT_SCHEMAS[type].safeParse(event);
  if (result.success) return null;
  const issue = result.error.issues[0];
  if (!issue) return "event is invalid";
  return `${issue.path.length ? issue.path.join(".") : "event"}: ${issue.message}`;
}

export function isValidEvent(event: unknown): event is CollectorEvent {
  return validateEvent(event) === null;
}
