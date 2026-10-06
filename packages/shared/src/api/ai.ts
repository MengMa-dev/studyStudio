import { z } from "zod";

/** Must match `AI_TASKS` / `PROVIDER_TYPES` in services/local-ingestion/src/ai/types.ts. */
export const AI_TASK_NAMES = ["learning_judge", "knowledge_processing", "entry_rewrite", "embedding", "chat"] as const;
export const aiTaskSchema = z.enum(AI_TASK_NAMES);
export type AiTaskName = z.infer<typeof aiTaskSchema>;

export const AI_PROVIDER_TYPES = ["openai-compatible", "google", "ollama", "mock", "anthropic", "agent-cli"] as const;
export const aiProviderTypeSchema = z.enum(AI_PROVIDER_TYPES);
export type AiProviderType = z.infer<typeof aiProviderTypeSchema>;

export const aiProviderStatusSchema = z.enum(["unconfigured", "connected", "error"]);
export type AiProviderStatus = z.infer<typeof aiProviderStatusSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const count = z.number().int().nonnegative();

/** API keys live in secrets.json and are only ever returned masked (`sk-…abcd`). */
export const aiProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: aiProviderTypeSchema,
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  apiKeyMasked: z.string().nullable(),
  hasApiKey: z.boolean(),
  status: aiProviderStatusSchema,
  checkedAt: z.string().nullable(),
  usedByTasks: z.array(aiTaskSchema)
});
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const aiProvidersResponseSchema = z.object({
  providers: z.array(aiProviderSchema)
});
export type AiProvidersResponse = z.infer<typeof aiProvidersResponseSchema>;

export const aiProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: aiProviderTypeSchema,
  baseUrl: z.url().nullable().optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: z.string().trim().min(1).max(500).nullable().optional()
});
export type AiProviderCreate = z.infer<typeof aiProviderCreateSchema>;

/** `apiKey: null` clears the stored key; omitted keeps it. */
export const aiProviderPatchSchema = aiProviderCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field required" });
export type AiProviderPatch = z.infer<typeof aiProviderPatchSchema>;

/** `DELETE` returns 409 `{ error: "provider_in_use", tasks }` while any task still references it. */
export const aiProviderDeleteResponseSchema = z.object({
  ok: z.literal(true)
});
export type AiProviderDeleteResponse = z.infer<typeof aiProviderDeleteResponseSchema>;

/** Overrides let the dialog test unsaved values before saving. */
export const aiProviderTestRequestSchema = z.object({
  model: z.string().trim().min(1).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).optional()
});
export type AiProviderTestRequest = z.infer<typeof aiProviderTestRequestSchema>;

export const aiProviderTestResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: count,
  models: z.array(z.string()).optional(),
  error: z.string().optional(),
  status: aiProviderStatusSchema,
  checkedAt: z.string()
});
export type AiProviderTestResponse = z.infer<typeof aiProviderTestResponseSchema>;

export const aiTaskModelSchema = z.object({
  task: aiTaskSchema,
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  fallbackProviderId: z.string().nullable(),
  fallbackModel: z.string().nullable()
});
export type AiTaskModel = z.infer<typeof aiTaskModelSchema>;

/** Always lists every task; unconfigured ones have null provider/model. */
export const aiTasksResponseSchema = z.object({
  tasks: z.array(aiTaskModelSchema)
});
export type AiTasksResponse = z.infer<typeof aiTasksResponseSchema>;

export const aiTaskModelUpdateSchema = z.object({
  task: aiTaskSchema,
  providerId: z.string().min(1),
  model: z.string().trim().min(1),
  fallbackProviderId: z.string().min(1).nullable().default(null),
  fallbackModel: z.string().trim().min(1).nullable().default(null)
});
export type AiTaskModelUpdate = z.infer<typeof aiTaskModelUpdateSchema>;

export const aiTasksUpdateSchema = z.object({
  tasks: z.array(aiTaskModelUpdateSchema).min(1)
});
export type AiTasksUpdate = z.infer<typeof aiTasksUpdateSchema>;
export type AiTasksUpdateInput = z.input<typeof aiTasksUpdateSchema>;

/** `day` defaults to today (UTC, same as `usage_daily.day`). */
export const aiUsageQuerySchema = z.object({
  day: day.optional()
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

export const aiUsageRowSchema = z.object({
  task: aiTaskSchema,
  providerId: z.string(),
  calls: count,
  inputTokens: count,
  outputTokens: count
});
export type AiUsageRow = z.infer<typeof aiUsageRowSchema>;

export const aiUsageResponseSchema = z.object({
  day,
  calls: count,
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  /** Null = unlimited. */
  dailyTokenLimit: count.nullable(),
  limitReached: z.boolean(),
  rows: z.array(aiUsageRowSchema)
});
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;

export const aiLimitsSchema = z.object({
  dailyTokenLimit: z.number().int().positive().nullable()
});
export type AiLimits = z.infer<typeof aiLimitsSchema>;

export const AI_API = {
  providers: "/v1/ai/providers",
  provider: (id: string) => `/v1/ai/providers/${encodeURIComponent(id)}`,
  testProvider: (id: string) => `/v1/ai/providers/${encodeURIComponent(id)}/test`,
  tasks: "/v1/ai/tasks",
  usage: "/v1/ai/usage",
  limits: "/v1/ai/limits"
} as const;
