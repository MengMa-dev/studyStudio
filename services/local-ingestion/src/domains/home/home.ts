import type { DatabaseSync } from "node:sqlite";
import type { HomeSummaryResponse } from "@study-studio/shared";
import { readLearnerProfile } from "../data/profile.js";
import { getPending, getToday } from "../timeline/timeline.js";

export function greetingPeriod(now: Date): HomeSummaryResponse["greetingPeriod"] {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

export function getHomeSummary(db: DatabaseSync, now = new Date()): HomeSummaryResponse {
  const knowledgeEntryCount = Number((db.prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE deleted_at IS NULL").get() as { n: number }).n);
  return {
    greetingPeriod: greetingPeriod(now),
    today: getToday(db, now),
    pending: getPending(db),
    knowledgeEntryCount,
    profile: readLearnerProfile(db)
  };
}
