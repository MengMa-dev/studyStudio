import type { DatabaseSync } from "node:sqlite";
import type { IntegrationResult } from "./integrate.js";
import { indexEntrySummary, type IndexContext } from "./kb-index.js";
import { setJob, type JobStatus } from "./run-store.js";
import { loadEntry, type OrganizeItem } from "./store.js";

export type CommitDeps = { db: DatabaseSync; indexCtx: IndexContext; runId: string };

/** Indexes touched entry summaries and sets item jobs. Returns entry ids queued for body indexing. */
export async function commitUnit(deps: CommitDeps, items: OrganizeItem[], result: IntegrationResult | null, status: JobStatus): Promise<string[]> {
  const indexed: string[] = [];
  for (const entryId of result?.touchedEntryIds ?? []) {
    const entry = loadEntry(deps.db, entryId);
    if (!entry) continue;
    await indexEntrySummary(deps.indexCtx, entry);
    indexed.push(entryId);
  }
  for (const item of items) setJob(deps.db, deps.runId, "item", item.id, status);
  return indexed;
}
