import { z } from "zod";

import { learnerProfileSchema } from "../settings";
import { overviewTodaySchema, overviewPendingSchema } from "./timeline";

export const homeSummaryResponseSchema = z.object({
  greetingPeriod: z.enum(["morning", "afternoon", "evening", "night"]),
  today: overviewTodaySchema,
  pending: overviewPendingSchema,
  knowledgeEntryCount: z.number().int().nonnegative(),
  profile: learnerProfileSchema
});
export type HomeSummaryResponse = z.infer<typeof homeSummaryResponseSchema>;

export const HOME_API = {
  summary: "/v1/workbench/home"
} as const;
