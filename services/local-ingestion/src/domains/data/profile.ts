import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_LEARNER_PROFILE, learnerProfileSchema, type LearnerProfile } from "@study-studio/shared";
import { getLearnerProfile } from "../settings/settings.js";

const LEARNER_KEY = "learner_profile";
const ONBOARDING_KEY = "onboarding";

function writeSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

/** Stored values that no longer match the schema fall back to the default profile. */
export function readLearnerProfile(db: DatabaseSync): LearnerProfile {
  const parsed = learnerProfileSchema.safeParse(getLearnerProfile(db));
  return parsed.success ? parsed.data : DEFAULT_LEARNER_PROFILE;
}

export function saveLearnerProfile(db: DatabaseSync, profile: LearnerProfile): LearnerProfile {
  writeSetting(db, LEARNER_KEY, profile);
  return profile;
}

export function onboardingCompleted(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(ONBOARDING_KEY) as { value: string | null } | undefined;
  if (!row?.value) return false;
  try {
    return Boolean((JSON.parse(row.value) as { completedAt?: string }).completedAt);
  } catch {
    return false;
  }
}

export function completeOnboarding(db: DatabaseSync, now = new Date()): void {
  writeSetting(db, ONBOARDING_KEY, { completedAt: now.toISOString() });
}
