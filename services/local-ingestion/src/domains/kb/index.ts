export { getKbTree } from "./tree.js";
export { getKbEntryDetail, parseEvidence } from "./detail.js";
export { patchKbEntry, recomputeAutoMastery, stripSuggestionSection, type PatchKbEntryResult } from "./edit.js";
export { deleteKbEntries, getKbDeleteImpact, parseIdList, KB_TRASH_RETENTION_DAYS } from "./delete.js";
export {
  createKbRegistryTrashHandler,
  createKbTrashHandler,
  kbTrashHandler,
  parseKbTrashSnapshot,
  toKbTrashSnapshot,
  KB_TRASH_KIND,
  type KbTrashHandler,
  type KbTrashRestoreResult,
  type KbTrashSnapshot
} from "./trash.js";
export {
  EMPTY_MASTERY_SIGNALS,
  MASTERY_K,
  MASTERY_WEIGHTS,
  WEAK_MASTERY_THRESHOLD,
  effectiveMastery,
  estimateMastery,
  saturate,
  type MasterySignals
} from "./mastery.js";
export { KB_ENTRY_OWNER_TYPE, entryIndexText, type KbSearchIndex } from "./search-sync.js";
