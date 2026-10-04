import {
  AI_API,
  applyCaptureRulesUpdate,
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
  KB_API,
  learnerProfileResponseSchema,
  learnerProfileSchema,
  NOTES_API,
  notesListResponseSchema,
  noteSchema,
  onboardingStatusSchema,
  ORGANIZE_API,
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
  type Note,
  type PatchNoteRequest
} from "@study-studio/shared";

import { mockAgentApi, resetMockAgentState } from "./agent";
import { mockAiApi, resetMockAiState } from "./ai";
import { mockChatApi, resetMockChatState } from "./chat";
import { mockKbApi, resetMockKbState } from "./kb";
import { mockOrganizeApi, resetMockOrganizeState } from "./organize";
import { createSeedState, decodeCursor, encodeCursor, toListRow, type MockItem, type MockState } from "./seed";

let state: MockState = createSeedState();

export function resetMockState(): void {
  state = createSeedState();
  resetMockKbState();
  resetMockOrganizeState();
  resetMockAiState();
  resetMockChatState();
  resetMockAgentState();
}

export function getMockState(): MockState {
  return state;
}

function activeItems(): MockItem[] {
  return state.items.filter((item) => !item.deletedAt);
}

function refreshDerived(): void {
  state.dataInfo.itemCount = activeItems().length;
  state.overview.pending.unread = activeItems().filter((item) => item.readStatus === "unread").length;
  state.overview.pending.pendingOrganize = activeItems().filter((item) => item.organizeStatus === "pending" || item.organizeStatus === "failed").length;
  state.home.today = state.overview.today;
  state.home.pending = state.overview.pending;
  state.home.profile = state.profile;
  state.settings.exclusionRules = state.rules;
}

function compareCursor(a: { capturedAt: string; id: string }, b: { capturedAt: string; id: string }): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function matchesStatus(item: MockItem, status: InboxListQuery["status"]): boolean {
  if (status === "all") return true;
  if (status === "unread") return item.readStatus === "unread";
  if (status === "read") return item.readStatus === "read";
  if (status === "pending") return item.organizeStatus === "pending" || item.organizeStatus === "failed";
  if (status === "ingested") return item.organizeStatus === "ingested";
  if (status === "rejected") return item.organizeStatus === "rejected";
  return true;
}

function listRows(query: InboxListQuery) {
  const items = activeItems()
    .filter((item) => (query.type === "all" ? true : item.type === query.type))
    .filter((item) => matchesStatus(item, query.status))
    .map(toListRow);

  const fuzzy =
    query.type === "all" && query.status === "all"
      ? state.notes
          .filter((note) => note.scope === "fuzzy" && !("deletedAt" in note && (note as Note & { deletedAt?: string }).deletedAt))
          .filter((note) => !(note as Note & { deletedAt?: string | null }).deletedAt)
          .map((note) => ({
            kind: "fuzzy_note" as const,
            id: note.id,
            text: note.text,
            origin: note.origin,
            createdAt: note.createdAt
          }))
      : [];

  const rows = [...items, ...fuzzy].sort((a, b) => {
    const aAt = a.kind === "item" ? a.capturedAt : a.createdAt;
    const bAt = b.kind === "item" ? b.capturedAt : b.createdAt;
    if (aAt !== bAt) return aAt < bAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  let start = 0;
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    const index = rows.findIndex((row) => {
      const at = row.kind === "item" ? row.capturedAt : row.createdAt;
      return compareCursor({ capturedAt: at, id: row.id }, cursor) > 0;
    });
    start = index === -1 ? rows.length : index;
  }

  const page = rows.slice(start, start + query.limit);
  const last = page.at(-1);
  const nextCursor = last ? encodeCursor(last.kind === "item" ? last.capturedAt : last.createdAt, last.id) : null;
  const hasMore = start + query.limit < rows.length;

  return inboxListResponseSchema.parse({
    rows: page,
    nextCursor: hasMore ? nextCursor : null,
    total: rows.length
  });
}

function detailOf(id: string) {
  const item = activeItems().find((entry) => entry.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const notes = state.notes.filter((note) => note.scope === "item" && note.targetId === id && !(note as Note & { deletedAt?: string | null }).deletedAt);
  const unusedNoteCount = notes.filter((note) => !note.usedAt).length;
  return inboxItemDetailSchema.parse({
    ...item,
    notes,
    unusedNoteCount: unusedNoteCount + (item.dirty ? 1 : 0)
  });
}

function softDeleteNotes(ids: string[]): Note[] {
  const removed: Note[] = [];
  state.notes = state.notes.filter((note) => {
    if (!ids.includes(note.id)) return true;
    removed.push(note);
    return false;
  });
  return removed;
}

export const mockApi = {
  ...mockKbApi,
  ...mockOrganizeApi,
  ...mockAiApi,
  ...mockChatApi,
  ...mockAgentApi,

  async getHomeSummary() {
    refreshDerived();
    return homeSummaryResponseSchema.parse(state.home);
  },

  async getInboxList(rawQuery: Partial<InboxListQuery> = {}) {
    const query = inboxListQuerySchema.parse(rawQuery);
    return listRows(query);
  },

  async getInboxItem(id: string) {
    const detail = detailOf(id);
    if (detail.readStatus === "unread") {
      const item = state.items.find((entry) => entry.id === id);
      if (item) item.readStatus = "read";
      return detailOf(id);
    }
    return detail;
  },

  async patchInboxItem(id: string, patch: InboxItemPatch) {
    const body = inboxItemPatchSchema.parse(patch);
    const item = activeItems().find((entry) => entry.id === id);
    if (!item) throw new Error(`Item not found: ${id}`);
    if (body.readStatus) item.readStatus = body.readStatus;
    if (body.tags) item.tags = body.tags;
    if (body.title) item.title = body.title;
    if (body.markdown !== undefined) {
      if (!item.originalMarkdown) item.originalMarkdown = item.markdown;
      item.markdown = body.markdown;
      item.editedAt = new Date().toISOString();
      item.dirty = true;
    }
    return detailOf(id);
  },

  async bulkInbox(action: InboxBulkAction) {
    const body = inboxBulkActionSchema.parse(action);
    let updated = 0;
    for (const id of body.ids) {
      const item = activeItems().find((entry) => entry.id === id);
      if (!item) continue;
      if (body.action === "read_status") {
        item.readStatus = body.readStatus;
        updated += 1;
      } else if (body.action === "tags") {
        item.tags = body.mode === "set" ? [...body.tags] : [...new Set([...item.tags, ...body.tags])];
        updated += 1;
      }
    }
    return inboxBulkResponseSchema.parse({ updated });
  },

  async getDeleteImpact(ids: string[], noteIds: string[] = []) {
    const items = activeItems().filter((item) => ids.includes(item.id));
    const related = items.flatMap((item) => item.relatedEntries);
    const unique = new Map(related.map((entry) => [entry.id, entry]));
    const entries = [...unique.values()];
    return deleteImpactResponseSchema.parse({
      itemCount: items.length,
      noteCount: noteIds.length,
      entriesToDelete: entries.slice(0, Math.min(1, entries.length)).map((entry) => ({ id: entry.id, name: entry.name })),
      entriesToStale: entries.slice(1).map((entry) => ({ id: entry.id, name: entry.name })),
      entriesToOrphan: [],
      evidenceCount: related.length
    });
  },

  async deleteItems(request: DeleteItemsRequest) {
    const body = deleteItemsRequestSchema.parse(request);
    const deletedItems = activeItems().filter((item) => body.ids.includes(item.id));
    const deletedNotes = softDeleteNotes(body.noteIds);
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const trashId = `trash-${Date.now()}`;

    for (const item of deletedItems) item.deletedAt = now;

    if (body.rule === "url" || body.rule === "domain") {
      for (const item of deletedItems) {
        if (!item.url) continue;
        const value = body.rule === "domain" ? new URL(item.url).hostname : item.url;
        state.rules.push({
          id: `rule-${Date.now()}-${item.id}`,
          kind: body.rule,
          value,
          note: "删除时添加",
          createdAt: now
        });
      }
    }

    state.trash.unshift({
      id: trashId,
      kind: deletedItems.length && deletedNotes.length ? "mixed" : deletedItems.length ? "items" : "notes",
      title: deletedItems[0]?.title ?? deletedNotes[0]?.text ?? "已删除内容",
      site: deletedItems[0]?.site ?? null,
      itemType: deletedItems[0]?.type ?? null,
      deletedAt: now,
      expiresAt: expires,
      removeFromKb: body.removeFromKb,
      removedEntryCount: body.removeFromKb ? deletedItems.reduce((sum, item) => sum + Math.min(1, item.relatedEntries.length), 0) : 0,
      itemIds: deletedItems.map((item) => item.id),
      noteIds: deletedNotes.map((note) => note.id),
      entryIds: [],
      snapshot: { items: structuredClone(deletedItems), notes: structuredClone(deletedNotes) }
    });

    state.timeline = state.timeline.map((day) => ({
      ...day,
      rows: day.rows.filter((row) => !body.ids.includes(row.itemId ?? "") && !body.noteIds.includes(row.noteId ?? ""))
    }));

    refreshDerived();
    return deleteItemsResponseSchema.parse({
      trashId,
      deletedItemCount: deletedItems.length,
      deletedNoteCount: deletedNotes.length
    });
  },

  async listNotes(scope?: string, targetId?: string) {
    const notes = state.notes.filter((note) => {
      if (scope && note.scope !== scope) return false;
      if (targetId && note.targetId !== targetId) return false;
      return true;
    });
    return notesListResponseSchema.parse({ notes });
  },

  async createNote(request: CreateNoteRequest) {
    const body = createNoteRequestSchema.parse(request);
    const note = noteSchema.parse({
      id: `note-${Date.now()}`,
      scope: body.scope,
      targetId: body.targetId ?? null,
      text: body.text,
      origin: body.origin,
      usedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: null
    });
    state.notes.unshift(note);
    if (note.scope === "item" && note.targetId) {
      const item = activeItems().find((entry) => entry.id === note.targetId);
      if (item && item.organizeStatus === "ingested") item.dirty = true;
    }
    return note;
  },

  async patchNote(id: string, request: PatchNoteRequest) {
    const body = patchNoteRequestSchema.parse(request);
    const note = state.notes.find((entry) => entry.id === id);
    if (!note) throw new Error(`Note not found: ${id}`);
    note.text = body.text;
    note.updatedAt = new Date().toISOString();
    note.usedAt = null;
    return noteSchema.parse(note);
  },

  async deleteNote(id: string) {
    softDeleteNotes([id]);
    return { ok: true as const };
  },

  async getTimeline(raw: Record<string, string | undefined> = {}) {
    const query = timelineQuerySchema.parse(raw);
    const types = query.types ? new Set(query.types.split(",").filter(Boolean)) : null;
    const days = state.timeline.map((day) => ({
      ...day,
      rows: types ? day.rows.filter((row) => types.has(row.type)) : day.rows
    }));
    return timelineResponseSchema.parse({ days });
  },

  async getOverview(raw: Record<string, string | undefined> = {}) {
    overviewQuerySchema.parse(raw);
    refreshDerived();
    return overviewResponseSchema.parse(state.overview);
  },

  async getPresence() {
    return presenceResponseSchema.parse(state.presence);
  },

  async listTrash() {
    return trashListResponseSchema.parse({
      entries: state.trash.map(({ snapshot: _snapshot, ...entry }) => entry)
    });
  },

  async restoreTrash(id: string) {
    const entry = state.trash.find((item) => item.id === id);
    if (!entry) throw new Error(`Trash not found: ${id}`);
    for (const item of entry.snapshot.items) {
      const existing = state.items.find((candidate) => candidate.id === item.id);
      if (existing) existing.deletedAt = null;
      else state.items.push({ ...item, deletedAt: null });
    }
    for (const note of entry.snapshot.notes) {
      if (!state.notes.some((candidate) => candidate.id === note.id)) state.notes.push(note);
    }
    state.trash = state.trash.filter((item) => item.id !== id);
    refreshDerived();
    return trashRestoreResponseSchema.parse({
      restoredItemCount: entry.snapshot.items.length,
      restoredNoteCount: entry.snapshot.notes.length
    });
  },

  async purgeTrash(id: string) {
    state.trash = state.trash.filter((item) => item.id !== id);
    return trashPurgeResponseSchema.parse({ ok: true });
  },

  async getSettings() {
    return collectorSettingsSchema.parse({ ...state.settings, exclusionRules: state.rules });
  },

  async putSettings(update: unknown) {
    const body = collectorSettingsUpdateSchema.parse(update);
    if (body.captureRules) {
      state.settings.captureRules = applyCaptureRulesUpdate(state.settings.captureRules, body.captureRules);
    }
    if (body.activityTracking) {
      state.settings.activityTracking = { ...state.settings.activityTracking, ...body.activityTracking };
    }
    if (body.conversationPlatforms) {
      state.settings.conversationPlatforms = { ...state.settings.conversationPlatforms, ...body.conversationPlatforms };
    }
    return collectorSettingsSchema.parse({ ...state.settings, exclusionRules: state.rules });
  },

  async listRules() {
    return { rules: state.rules.map((rule) => exclusionRuleSchema.parse(rule)) };
  },

  async createRule(input: unknown) {
    const body = exclusionRuleInputSchema.parse(input);
    const rule = exclusionRuleSchema.parse({
      id: `rule-${Date.now()}`,
      kind: body.kind,
      value: body.value,
      note: body.note ?? null,
      createdAt: new Date().toISOString()
    });
    state.rules.push(rule);
    return rule;
  },

  async deleteRule(id: string) {
    state.rules = state.rules.filter((rule) => rule.id !== id);
    return { ok: true as const };
  },

  async getDataInfo() {
    refreshDerived();
    const token = state.dataInfo.pairingToken;
    return dataInfoResponseSchema.parse({
      ...state.dataInfo,
      pairingTokenMasked: `${token.slice(0, 8)}••••••••••••${token.slice(-4)}`,
      pairingToken: token
    });
  },

  async exportData() {
    return dataExportResponseSchema.parse({
      filename: `studystudio-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      sizeBytes: 1_024_000
    });
  },

  async importData(_file: File) {
    return dataImportResponseSchema.parse({ ok: true, itemCount: activeItems().length });
  },

  async reindex() {
    return dataReindexResponseSchema.parse({ jobId: `reindex-${Date.now()}`, status: "queued" });
  },

  async revealDataDir() {
    return dataRevealResponseSchema.parse({ ok: true });
  },

  async resetPairing() {
    const token = `token-${Date.now()}-abcdef01`;
    state.dataInfo.pairingToken = token;
    return pairingResetResponseSchema.parse({
      token,
      masked: `${token.slice(0, 8)}••••••••••••${token.slice(-4)}`
    });
  },

  async wipeData(request: unknown) {
    dataWipeRequestSchema.parse(request);
    state = createSeedState();
    state.items = [];
    state.notes = [];
    state.trash = [];
    state.timeline = [];
    refreshDerived();
    return dataWipeResponseSchema.parse({
      ok: true,
      backupFilename: `studystudio-wipe-${new Date().toISOString().slice(0, 10)}.db`
    });
  },

  async getLearnerProfile() {
    return learnerProfileResponseSchema.parse({ profile: state.profile });
  },

  async putLearnerProfile(profile: LearnerProfile) {
    state.profile = learnerProfileSchema.parse(profile);
    state.home.profile = state.profile;
    return learnerProfileResponseSchema.parse({ profile: state.profile });
  },

  async getOnboarding() {
    return onboardingStatusSchema.parse({
      needsOnboarding: !state.onboardingDone,
      pairingToken: state.dataInfo.pairingToken,
      extensionConnected: state.dataInfo.extensionConnected
    });
  },

  async completeOnboarding() {
    state.onboardingDone = true;
    return onboardingStatusSchema.parse({
      needsOnboarding: false,
      pairingToken: state.dataInfo.pairingToken,
      extensionConnected: state.dataInfo.extensionConnected
    });
  }
};

export const mockPaths = {
  HOME_API,
  INBOX_API,
  NOTES_API,
  TIMELINE_API,
  TRASH_API,
  DATA_API,
  RULES_API,
  SETTINGS_API,
  KB_API,
  ORGANIZE_API,
  AI_API
};

export type WorkbenchApi = typeof mockApi;
