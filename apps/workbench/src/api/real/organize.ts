import {
  ORGANIZE_API,
  organizeEventSchema,
  organizePreviewRequestSchema,
  organizePreviewResponseSchema,
  organizeRunDetailSchema,
  organizeRunRequestSchema,
  organizeRunsQuerySchema,
  organizeRunsResponseSchema,
  organizeRunStartResponseSchema,
  organizeSettingsResponseSchema,
  organizeSettingsUpdateSchema,
  type OrganizeEvent,
  type OrganizeEventType,
  type OrganizePreviewRequestInput,
  type OrganizeRunRequestInput,
  type OrganizeRunsQuery,
  type OrganizeSettingsUpdate
} from "@study-studio/shared";

import { qs, request } from "./http";

const EVENT_TYPES: OrganizeEventType[] = ["run_started", "run_progress", "item_done", "run_paused", "run_finished", "run_failed", "heartbeat"];

export const realOrganizeApi = {
  async getOrganizeSettings() {
    return request(ORGANIZE_API.settings, undefined, organizeSettingsResponseSchema);
  },

  async putOrganizeSettings(update: OrganizeSettingsUpdate) {
    const body = organizeSettingsUpdateSchema.parse(update);
    return request(ORGANIZE_API.settings, { method: "PUT", body: JSON.stringify(body) }, organizeSettingsResponseSchema);
  },

  async previewOrganize(requestBody: OrganizePreviewRequestInput) {
    const body = organizePreviewRequestSchema.parse(requestBody);
    return request(ORGANIZE_API.preview, { method: "POST", body: JSON.stringify(body) }, organizePreviewResponseSchema);
  },

  async runOrganize(requestBody: OrganizeRunRequestInput) {
    const body = organizeRunRequestSchema.parse(requestBody);
    return request(ORGANIZE_API.run, { method: "POST", body: JSON.stringify(body) }, organizeRunStartResponseSchema);
  },

  async listOrganizeRuns(rawQuery: Partial<OrganizeRunsQuery> = {}) {
    const query = organizeRunsQuerySchema.parse(rawQuery);
    return request(`${ORGANIZE_API.runs}${qs({ cursor: query.cursor, limit: query.limit })}`, undefined, organizeRunsResponseSchema);
  },

  async getOrganizeRun(id: string) {
    return request(ORGANIZE_API.runDetail(id), undefined, organizeRunDetailSchema);
  },

  async retryOrganizeRun(id: string) {
    return request(ORGANIZE_API.retry(id), { method: "POST" }, organizeRunStartResponseSchema);
  },

  /** Returns an unsubscribe function. */
  subscribeOrganizeEvents(onEvent: (event: OrganizeEvent) => void): () => void {
    const source = new EventSource(ORGANIZE_API.events, { withCredentials: true });
    const handle = (message: MessageEvent<string>) => {
      const parsed = organizeEventSchema.safeParse(JSON.parse(message.data));
      if (parsed.success) onEvent(parsed.data);
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, handle);
    return () => source.close();
  }
};
