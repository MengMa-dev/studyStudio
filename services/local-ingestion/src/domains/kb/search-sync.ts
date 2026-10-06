import type { DatabaseSync } from "node:sqlite";
import { stripSectionMarkers } from "@study-studio/shared";
import type { SearchIndex } from "../../search/index-api.js";
import type { KbEntryRow } from "../../db/types.js";
import { ENTRY_OWNER } from "../organize/runtime-types.js";
import { loadAliveEntries, parseAliases } from "./queries.js";

/** Same owner type as the organize pipeline's entry chunks (07 ④). */
export const KB_ENTRY_OWNER_TYPE = "entry";

export type KbSearchIndex = Pick<SearchIndex, "indexDocument" | "deleteOwner">;

export function entryIndexText(row: Pick<KbEntryRow, "name" | "aliases" | "summary" | "body_markdown">): string {
  return [row.name, parseAliases(row.aliases).join(" "), row.summary ?? "", stripSectionMarkers(row.body_markdown ?? "")].filter((part) => part.trim()).join("\n\n");
}

/** Best effort: the index is derived data and can be rebuilt via reindex. */
export async function reindexEntries(index: KbSearchIndex | undefined, db: DatabaseSync, ids: readonly string[]): Promise<void> {
  if (!index || ids.length === 0) return;
  for (const row of loadAliveEntries(db, ids)) {
    try {
      await index.indexDocument({ ownerType: KB_ENTRY_OWNER_TYPE, ownerId: row.id, text: entryIndexText(row) });
    } catch (error) {
      console.warn(`[kb] reindex entry ${row.id} failed`, error);
    }
  }
}

export function removeEntriesFromIndex(index: KbSearchIndex | undefined, ids: readonly string[]): void {
  if (!index) return;
  for (const id of ids) {
    try {
      for (const ownerType of Object.values(ENTRY_OWNER)) index.deleteOwner(ownerType, id);
    } catch (error) {
      console.warn(`[kb] remove entry ${id} from index failed`, error);
    }
  }
}
