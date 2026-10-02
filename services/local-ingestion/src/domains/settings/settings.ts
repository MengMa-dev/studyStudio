import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ACTIVITY_TRACKING,
  DEFAULT_CAPTURE_RULES,
  DEFAULT_CONVERSATION_PLATFORMS,
  DEFAULT_LEARNER_PROFILE,
  DEFAULT_ORGANIZE_SETTINGS,
  applyCaptureRulesUpdate,
  collectorSettingsSchema,
  collectorSettingsUpdateSchema,
  type ActivityTracking,
  type CaptureRules,
  type CollectorSettings,
  type CollectorSettingsUpdate,
  type ConversationPlatforms,
  type ExclusionRule,
  type LearnerProfile,
  type OrganizeSettings
} from "@study-studio/shared";
import { listRules } from "../capture/rules.js";

/** Bump when built-in domain category lists change (01 / shared domains). */
const DOMAIN_CATEGORY_VERSION = 1;

const SETTINGS_KEY = "collector";
const ORGANIZE_KEY = "organize";
const LEARNER_KEY = "learner_profile";

/** Built-in list-page patterns (read-only, shipped with the release). */
export const BUILTIN_LIST_PAGE_RULES = ["*/search*", "*/tag/*", "*/tags/*", "*/category/*", "*/categories/*", "*/page/*", "*/archive*"];

type StoredCollectorSettings = {
  captureRules: CaptureRules;
  activityTracking: ActivityTracking;
  conversationPlatforms: ConversationPlatforms;
};

const DEFAULT_STORED: StoredCollectorSettings = {
  captureRules: DEFAULT_CAPTURE_RULES,
  activityTracking: DEFAULT_ACTIVITY_TRACKING,
  conversationPlatforms: DEFAULT_CONVERSATION_PLATFORMS
};

function readJson<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function writeJson(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

export function getStoredCollectorSettings(db: DatabaseSync): StoredCollectorSettings {
  return readJson(db, SETTINGS_KEY, DEFAULT_STORED);
}

export function getOrganizeSettings(db: DatabaseSync): OrganizeSettings {
  return readJson(db, ORGANIZE_KEY, DEFAULT_ORGANIZE_SETTINGS);
}

export function getLearnerProfile(db: DatabaseSync): LearnerProfile {
  return readJson(db, LEARNER_KEY, DEFAULT_LEARNER_PROFILE);
}

export function buildCollectorSettings(db: DatabaseSync, exclusionRules?: ExclusionRule[]): CollectorSettings {
  const stored = getStoredCollectorSettings(db);
  const rules = exclusionRules ?? listRules(db);
  return collectorSettingsSchema.parse({
    captureRules: stored.captureRules,
    activityTracking: stored.activityTracking,
    conversationPlatforms: stored.conversationPlatforms,
    exclusionRules: rules,
    builtinListPageRules: BUILTIN_LIST_PAGE_RULES,
    domainCategoryVersion: DOMAIN_CATEGORY_VERSION
  });
}

export function settingsEtag(settings: CollectorSettings): string {
  const hash = createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

export function updateCollectorSettings(db: DatabaseSync, update: CollectorSettingsUpdate): CollectorSettings {
  const parsed = collectorSettingsUpdateSchema.parse(update);
  const current = getStoredCollectorSettings(db);
  const next: StoredCollectorSettings = {
    captureRules: parsed.captureRules ? applyCaptureRulesUpdate(current.captureRules, parsed.captureRules) : current.captureRules,
    activityTracking: { ...current.activityTracking, ...parsed.activityTracking },
    conversationPlatforms: { ...current.conversationPlatforms, ...parsed.conversationPlatforms }
  };
  writeJson(db, SETTINGS_KEY, next);
  return buildCollectorSettings(db);
}

export function ensureDefaultSettings(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 AS ok FROM settings WHERE key = ?").get(SETTINGS_KEY)) writeJson(db, SETTINGS_KEY, DEFAULT_STORED);
  if (!db.prepare("SELECT 1 AS ok FROM settings WHERE key = ?").get(ORGANIZE_KEY)) writeJson(db, ORGANIZE_KEY, DEFAULT_ORGANIZE_SETTINGS);
  if (!db.prepare("SELECT 1 AS ok FROM settings WHERE key = ?").get(LEARNER_KEY)) writeJson(db, LEARNER_KEY, DEFAULT_LEARNER_PROFILE);
}
