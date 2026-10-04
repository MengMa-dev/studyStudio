import {
  KB_API,
  kbDeleteImpactResponseSchema,
  kbDeleteRequestSchema,
  kbDeleteResponseSchema,
  kbEntryDetailSchema,
  kbEntryPatchSchema,
  kbGraphResponseSchema,
  kbKindRenameResponseSchema,
  kbKindRenameSchema,
  kbKindsResponseSchema,
  kbTreeQuerySchema,
  kbTreeResponseSchema,
  type KbDeleteRequestInput,
  type KbEntryPatch,
  type KbKindRename,
  type KbTreeQuery
} from "@study-studio/shared";

import { qs, request } from "./http";

export const realKbApi = {
  async getKbTree(rawQuery: Partial<KbTreeQuery> = {}) {
    const query = kbTreeQuerySchema.parse(rawQuery);
    return request(`${KB_API.tree}${qs({ q: query.q, kind: query.kind })}`, undefined, kbTreeResponseSchema);
  },

  async getKbGraph() {
    return request(KB_API.graph, undefined, kbGraphResponseSchema);
  },

  async getKbKinds() {
    return request(KB_API.kinds, undefined, kbKindsResponseSchema);
  },

  async renameKbKind(rename: KbKindRename) {
    const body = kbKindRenameSchema.parse(rename);
    return request(KB_API.kinds, { method: "PATCH", body: JSON.stringify(body) }, kbKindRenameResponseSchema);
  },

  async getKbEntry(id: string) {
    return request(KB_API.entry(id), undefined, kbEntryDetailSchema);
  },

  async patchKbEntry(id: string, patch: KbEntryPatch) {
    const body = kbEntryPatchSchema.parse(patch);
    return request(KB_API.patch(id), { method: "PATCH", body: JSON.stringify(body) }, kbEntryDetailSchema);
  },

  async getKbDeleteImpact(ids: string[]) {
    return request(`${KB_API.impact}${qs({ ids: ids.join(",") })}`, undefined, kbDeleteImpactResponseSchema);
  },

  async deleteKbEntries(requestBody: KbDeleteRequestInput) {
    const body = kbDeleteRequestSchema.parse(requestBody);
    return request(KB_API.delete, { method: "DELETE", body: JSON.stringify(body) }, kbDeleteResponseSchema);
  }
};
