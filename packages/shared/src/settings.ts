import { z } from "zod";

const ratio = z.number().min(0).max(1);
const boundedSeconds = z.number().int().min(0).max(3600);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a domain such as example.com");

/** Capture rules (01, formerly "learning threshold"): decide whether a page body is captured, never whether activity is recorded. */
export const CAPTURE_PRESETS = {
  standard: { minActiveSeconds: 90, minScrollDepth: 0.35, minRevisitSeconds: 60 },
  debug: { minActiveSeconds: 5, minScrollDepth: 0, minRevisitSeconds: 3 }
} as const;
export type CapturePreset = keyof typeof CAPTURE_PRESETS | "custom";

export const captureRulesSchema = z.object({
  preset: z.enum(["standard", "debug", "custom"]),
  minActiveSeconds: boundedSeconds,
  minScrollDepth: ratio,
  minRevisitSeconds: boundedSeconds,
  captureFromSearch: z.boolean(),
  /** Pages opened within this many minutes before or after an AI conversation are captured; 0 disables the rule. */
  aiConversationWindowMinutes: z.number().int().min(0).max(60)
});
export type CaptureRules = z.infer<typeof captureRulesSchema>;

export const activityTrackingSchema = z.object({
  enabled: z.boolean(),
  /** Added to the built-in `unrelated` category: only domain, category and duration are recorded. */
  unrelatedDomains: z.array(domain).max(500),
  retentionDays: z.number().int().min(1).max(365)
});
export type ActivityTracking = z.infer<typeof activityTrackingSchema>;

export const CONVERSATION_PLATFORMS = ["chatgpt", "deepseek"] as const;
export const conversationPlatformsSchema = z.object(
  Object.fromEntries(CONVERSATION_PLATFORMS.map((platform) => [platform, z.boolean()])) as Record<(typeof CONVERSATION_PLATFORMS)[number], z.ZodBoolean>
);
export type ConversationPlatforms = z.infer<typeof conversationPlatformsSchema>;

export const EXCLUSION_RULE_KINDS = ["url", "domain", "url_prefix", "list_page"] as const;
export const exclusionRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(EXCLUSION_RULE_KINDS),
  value: z.string().trim().min(1).max(2048),
  note: z.string().max(200).nullable(),
  createdAt: z.string()
});
export type ExclusionRule = z.infer<typeof exclusionRuleSchema>;
export const exclusionRuleInputSchema = exclusionRuleSchema.pick({ kind: true, value: true }).extend({ note: z.string().max(200).optional() });

/** `GET /v1/settings`: shared by the extension (with ETag) and the workbench. */
export const collectorSettingsSchema = z.object({
  captureRules: captureRulesSchema,
  activityTracking: activityTrackingSchema,
  conversationPlatforms: conversationPlatformsSchema,
  exclusionRules: z.array(exclusionRuleSchema),
  /** Read-only, shipped with the release. */
  builtinListPageRules: z.array(z.string()),
  domainCategoryVersion: z.number().int().min(1)
});
export type CollectorSettings = z.infer<typeof collectorSettingsSchema>;

/** `PUT /v1/settings`: exclusion rules go through `/v1/rules`, built-in lists are not editable. */
export const collectorSettingsUpdateSchema = z.object({
  captureRules: captureRulesSchema.partial().optional(),
  activityTracking: activityTrackingSchema.partial().optional(),
  conversationPlatforms: conversationPlatformsSchema.partial().optional()
});
export type CollectorSettingsUpdate = z.infer<typeof collectorSettingsUpdateSchema>;

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm");

/** Organize rules (07 / 10): triggers may be combined; all are disabled while `autoEnabled` is off. */
export const organizeSettingsSchema = z.object({
  autoEnabled: z.boolean(),
  triggers: z.object({
    daily: z.object({ enabled: z.boolean(), time: clockTime }),
    batch: z.object({ enabled: z.boolean(), count: z.number().int().min(1).max(500) }),
    onIngest: z.object({ enabled: z.boolean() })
  }),
  outputLanguage: z.enum(["zh", "source"])
});
export type OrganizeSettings = z.infer<typeof organizeSettingsSchema>;

export const LEARNING_DIRECTION_TTL_DAYS = 30;

/** Learner profile: extra context for judging and processing, never a reason to reject. */
export const learnerProfileSchema = z.object({
  role: z.string().trim().max(100),
  directions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().trim().min(1).max(100),
        expiresAt: z.iso.date()
      })
    )
    .max(20)
});
export type LearnerProfile = z.infer<typeof learnerProfileSchema>;

/** Directions whose `expiresAt` (inclusive, local date YYYY-MM-DD) has not passed. */
export function activeDirections(profile: LearnerProfile, today: string): LearnerProfile["directions"] {
  return profile.directions.filter((direction) => direction.expiresAt >= today);
}

export const DEFAULT_CAPTURE_RULES: CaptureRules = {
  preset: "standard",
  ...CAPTURE_PRESETS.standard,
  captureFromSearch: true,
  aiConversationWindowMinutes: 5
};

export const DEFAULT_ACTIVITY_TRACKING: ActivityTracking = { enabled: true, unrelatedDomains: [], retentionDays: 14 };

export const DEFAULT_CONVERSATION_PLATFORMS: ConversationPlatforms = { chatgpt: true, deepseek: true };

export const DEFAULT_ORGANIZE_SETTINGS: OrganizeSettings = {
  autoEnabled: true,
  triggers: {
    daily: { enabled: true, time: "23:00" },
    batch: { enabled: true, count: 10 },
    onIngest: { enabled: false }
  },
  outputLanguage: "zh"
};

export const DEFAULT_LEARNER_PROFILE: LearnerProfile = { role: "", directions: [] };

/** Applies a preset; changing any threshold by hand switches the preset to `custom`. */
export function applyCaptureRulesUpdate(current: CaptureRules, update: Partial<CaptureRules>): CaptureRules {
  if (update.preset && update.preset !== "custom") return { ...current, ...update, ...CAPTURE_PRESETS[update.preset] };
  const next = { ...current, ...update };
  const preset = next.preset === "custom" ? null : CAPTURE_PRESETS[next.preset];
  const thresholdsChanged =
    preset &&
    (next.minActiveSeconds !== preset.minActiveSeconds || next.minScrollDepth !== preset.minScrollDepth || next.minRevisitSeconds !== preset.minRevisitSeconds);
  return thresholdsChanged ? { ...next, preset: "custom" } : next;
}
