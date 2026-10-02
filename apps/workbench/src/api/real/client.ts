import { z } from "zod";
import {
  collectorSettingsSchema,
  collectorSettingsUpdateSchema,
  createNoteRequestSchema,
  DATA_API,
  dataExportResponseSchema,
  dataImportResponseSchema,
  dataInfoResponseSchema,
  dataReindexResponseSchema,
  dataRevealResponseSchema,
  dataWipeRequestSchema,
  dataWipeResponseSchema,
  deleteImpactResponseSchema,
  deleteItemsRequestSchema,
  deleteItemsResponseSchema,
  exclusionRuleInputSchema,
  exclusionRuleSchema,
  HOME_API,
  homeSummaryResponseSchema,
  INBOX_API,
  inboxBulkActionSchema,
  inboxBulkResponseSchema,
  inboxItemDetailSchema,
  inboxItemPatchSchema,
  inboxListQuerySchema,
  inboxListResponseSchema,
  learnerProfileResponseSchema,
  learnerProfileSchema,
  NOTES_API,
  notesListResponseSchema,
  noteSchema,
  onboardingStatusSchema,
  pairingResetResponseSchema,
  patchNoteRequestSchema,
  presenceResponseSchema,
  RULES_API,
  SETTINGS_API,
  TIMELINE_API,
  timelineQuerySchema,
  timelineResponseSchema,
  overviewQuerySchema,
  overviewResponseSchema,
  TRASH_API,
  trashListResponseSchema,
  trashPurgeResponseSchema,
  trashRestoreResponseSchema,
  type CreateNoteRequest,
  type DeleteItemsRequest,
  type InboxBulkAction,
  type InboxItemPatch,
  type InboxListQuery,
  type LearnerProfile,
  type PatchNoteRequest
} from "@study-studio/shared";

async function request<T>(path: string, init: RequestInit | undefined, schema: { parse: (data: unknown) => T }): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    },
    ...init
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${text || response.statusText}`);
  }
  if (response.status === 204) return schema.parse({});
  const data: unknown = await response.json();
  return schema.parse(data);
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const realApi = {
  async getHomeSummary() {
    return request(HOME_API.summary, undefined, homeSummaryResponseSchema);
  },

  async getInboxList(rawQuery: Partial<InboxListQuery> = {}) {
    const query = inboxListQuerySchema.parse(rawQuery);
    return request(
      `${INBOX_API.list}${qs({ type: query.type, status: query.status, cursor: query.cursor, limit: query.limit })}`,
      undefined,
      inboxListResponseSchema
    );
  },

  async getInboxItem(id: string) {
    return request(INBOX_API.detail(id), undefined, inboxItemDetailSchema);
  },

  async patchInboxItem(id: string, patch: InboxItemPatch) {
    const body = inboxItemPatchSchema.parse(patch);
    return request(INBOX_API.patch(id), { method: "PATCH", body: JSON.stringify(body) }, inboxItemDetailSchema);
  },

  async bulkInbox(action: InboxBulkAction) {
    const body = inboxBulkActionSchema.parse(action);
    return request(INBOX_API.bulk, { method: "POST", body: JSON.stringify(body) }, inboxBulkResponseSchema);
  },

  async getDeleteImpact(ids: string[], noteIds: string[] = []) {
    return request(`${INBOX_API.impact}${qs({ ids: ids.join(","), noteIds: noteIds.join(",") || undefined })}`, undefined, deleteImpactResponseSchema);
  },

  async deleteItems(requestBody: DeleteItemsRequest) {
    const body = deleteItemsRequestSchema.parse(requestBody);
    return request(INBOX_API.delete, { method: "DELETE", body: JSON.stringify(body) }, deleteItemsResponseSchema);
  },

  async listNotes(scope?: string, targetId?: string) {
    return request(`${NOTES_API.list}${qs({ scope, targetId })}`, undefined, notesListResponseSchema);
  },

  async createNote(requestBody: CreateNoteRequest) {
    const body = createNoteRequestSchema.parse(requestBody);
    return request(NOTES_API.create, { method: "POST", body: JSON.stringify(body) }, noteSchema);
  },

  async patchNote(id: string, requestBody: PatchNoteRequest) {
    const body = patchNoteRequestSchema.parse(requestBody);
    return request(NOTES_API.patch(id), { method: "PATCH", body: JSON.stringify(body) }, noteSchema);
  },

  async deleteNote(id: string) {
    return request(NOTES_API.delete(id), { method: "DELETE" }, z.object({ ok: z.literal(true) }));
  },

  async getTimeline(raw: Record<string, string | undefined> = {}) {
    const query = timelineQuerySchema.parse(raw);
    return request(`${TIMELINE_API.timeline}${qs(query)}`, undefined, timelineResponseSchema);
  },

  async getOverview(raw: Record<string, string | undefined> = {}) {
    const query = overviewQuerySchema.parse(raw);
    return request(`${TIMELINE_API.overview}${qs(query)}`, undefined, overviewResponseSchema);
  },

  async getPresence() {
    return request(TIMELINE_API.presence, undefined, presenceResponseSchema);
  },

  async listTrash() {
    return request(TRASH_API.list, undefined, trashListResponseSchema);
  },

  async restoreTrash(id: string) {
    return request(TRASH_API.restore(id), { method: "POST" }, trashRestoreResponseSchema);
  },

  async purgeTrash(id: string) {
    return request(TRASH_API.purge(id), { method: "DELETE" }, trashPurgeResponseSchema);
  },

  async getSettings() {
    return request(SETTINGS_API.get, undefined, collectorSettingsSchema);
  },

  async putSettings(update: unknown) {
    const body = collectorSettingsUpdateSchema.parse(update);
    return request(SETTINGS_API.put, { method: "PUT", body: JSON.stringify(body) }, collectorSettingsSchema);
  },

  async listRules() {
    return request(RULES_API.list, undefined, z.object({ rules: z.array(exclusionRuleSchema) }));
  },

  async createRule(input: unknown) {
    const body = exclusionRuleInputSchema.parse(input);
    return request(RULES_API.create, { method: "POST", body: JSON.stringify(body) }, exclusionRuleSchema);
  },

  async deleteRule(id: string) {
    return request(RULES_API.delete(id), { method: "DELETE" }, z.object({ ok: z.literal(true) }));
  },

  async getDataInfo() {
    return request(DATA_API.info, undefined, dataInfoResponseSchema);
  },

  async exportData() {
    return request(DATA_API.export, { method: "POST" }, dataExportResponseSchema);
  },

  async importData() {
    return request(DATA_API.import, { method: "POST" }, dataImportResponseSchema);
  },

  async reindex() {
    return request(DATA_API.reindex, { method: "POST" }, dataReindexResponseSchema);
  },

  async revealDataDir() {
    return request(DATA_API.reveal, { method: "POST" }, dataRevealResponseSchema);
  },

  async resetPairing() {
    return request(DATA_API.pairingReset, { method: "POST" }, pairingResetResponseSchema);
  },

  async wipeData(requestBody: unknown) {
    const body = dataWipeRequestSchema.parse(requestBody);
    return request(DATA_API.wipe, { method: "POST", body: JSON.stringify(body) }, dataWipeResponseSchema);
  },

  async getLearnerProfile() {
    return request(DATA_API.learnerProfile, undefined, learnerProfileResponseSchema);
  },

  async putLearnerProfile(profile: LearnerProfile) {
    const body = learnerProfileSchema.parse(profile);
    return request(DATA_API.learnerProfile, { method: "PUT", body: JSON.stringify(body) }, learnerProfileResponseSchema);
  },

  async getOnboarding() {
    return request(DATA_API.onboarding, undefined, onboardingStatusSchema);
  },

  async completeOnboarding() {
    return request(DATA_API.onboarding, { method: "POST" }, onboardingStatusSchema);
  }
};
