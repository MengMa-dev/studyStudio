import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LEARNING_DIRECTION_TTL_DAYS, learnerProfileSchema, type ChatProfileCardData, type LearnerProfile } from "@study-studio/shared";
import { readLearnerProfile, saveLearnerProfile } from "../../data/profile.js";
import { addDays, localDay } from "../../timeline/time.js";

export const MAX_LEARNING_DIRECTIONS = 20;

export type ProfileToolResult = { status: "saved"; role: string; directions: string[] } | { status: "ignored"; reason: "empty_input" };

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `role` replaces the stored role; `direction` is appended (an existing same-text direction is renewed instead).
 * Expired directions are dropped and the oldest go first when the list exceeds the schema limit.
 */
export function mergeLearnerProfile(previous: LearnerProfile, input: { role?: string; direction?: string }, now: Date): LearnerProfile {
  const today = localDay(now);
  const role = input.role?.trim() ? input.role.trim() : previous.role;
  let directions = previous.directions.filter((direction) => direction.expiresAt >= today);
  const text = input.direction?.trim();
  if (text) {
    const expiresAt = addDays(today, LEARNING_DIRECTION_TTL_DAYS);
    const existing = directions.find((direction) => sameText(direction.text, text));
    directions = existing
      ? [...directions.filter((direction) => direction !== existing), { ...existing, expiresAt }]
      : [...directions, { id: randomUUID(), text, expiresAt }];
  }
  return learnerProfileSchema.parse({ role, directions: directions.slice(-MAX_LEARNING_DIRECTIONS) });
}

export function recordLearnerProfile(
  db: DatabaseSync,
  input: { role?: string; direction?: string },
  now: Date,
  emit: (data: ChatProfileCardData) => void
): ProfileToolResult {
  const role = input.role?.trim() || undefined;
  const direction = input.direction?.trim() || undefined;
  if (!role && !direction) return { status: "ignored", reason: "empty_input" };
  const previous = readLearnerProfile(db);
  const next = saveLearnerProfile(db, mergeLearnerProfile(previous, { role, direction }, now));
  const card: ChatProfileCardData = { previous: { role: previous.role, directions: previous.directions.map((item) => ({ ...item })) } };
  if (role) card.role = role;
  if (direction) card.direction = direction;
  emit(card);
  return { status: "saved", role: next.role, directions: next.directions.map((item) => item.text) };
}
