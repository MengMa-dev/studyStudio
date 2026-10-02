import { z } from "zod";

import { learnerProfileSchema } from "../settings";

export const dataInfoResponseSchema = z.object({
  address: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  sqliteVersion: z.string(),
  dataDir: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  extensionConnected: z.boolean(),
  extensionLastSeenAt: z.string().nullable(),
  extensionPendingCount: z.number().int().nonnegative(),
  pairingTokenMasked: z.string(),
  pairingToken: z.string().optional()
});
export type DataInfoResponse = z.infer<typeof dataInfoResponseSchema>;

export const dataExportResponseSchema = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative()
});
export type DataExportResponse = z.infer<typeof dataExportResponseSchema>;

export const dataImportResponseSchema = z.object({
  ok: z.literal(true),
  itemCount: z.number().int().nonnegative()
});
export type DataImportResponse = z.infer<typeof dataImportResponseSchema>;

export const dataReindexResponseSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(["queued", "running", "done"])
});
export type DataReindexResponse = z.infer<typeof dataReindexResponseSchema>;

export const dataRevealResponseSchema = z.object({
  ok: z.literal(true)
});
export type DataRevealResponse = z.infer<typeof dataRevealResponseSchema>;

export const pairingResetResponseSchema = z.object({
  token: z.string().min(1),
  masked: z.string()
});
export type PairingResetResponse = z.infer<typeof pairingResetResponseSchema>;

export const dataWipeRequestSchema = z.object({
  confirm: z.literal("清空")
});
export type DataWipeRequest = z.infer<typeof dataWipeRequestSchema>;

export const dataWipeResponseSchema = z.object({
  ok: z.literal(true),
  backupFilename: z.string().nullable()
});
export type DataWipeResponse = z.infer<typeof dataWipeResponseSchema>;

export const learnerProfileResponseSchema = z.object({
  profile: learnerProfileSchema
});
export type LearnerProfileResponse = z.infer<typeof learnerProfileResponseSchema>;

export const learnerProfileUpdateSchema = learnerProfileSchema;
export type LearnerProfileUpdate = z.infer<typeof learnerProfileUpdateSchema>;

export const onboardingStatusSchema = z.object({
  needsOnboarding: z.boolean(),
  pairingToken: z.string().nullable(),
  extensionConnected: z.boolean()
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

export const DATA_API = {
  info: "/v1/data/info",
  export: "/v1/data/export",
  import: "/v1/data/import",
  reindex: "/v1/data/reindex",
  reveal: "/v1/data/reveal",
  wipe: "/v1/data/wipe",
  pairingReset: "/v1/pairing/reset",
  learnerProfile: "/v1/settings/learner-profile",
  onboarding: "/v1/workbench/onboarding"
} as const;

/** Exclusion rules CRUD (shared schemas live in settings.ts). */
export const RULES_API = {
  list: "/v1/rules",
  create: "/v1/rules",
  delete: (id: string) => `/v1/rules/${encodeURIComponent(id)}`
} as const;

export const SETTINGS_API = {
  get: "/v1/settings",
  put: "/v1/settings"
} as const;
