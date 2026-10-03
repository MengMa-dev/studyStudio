import type { DatabaseSync } from "node:sqlite";
import { chunkText } from "../../search/chunk.js";
import type { SearchIndex } from "../../search/index-api.js";
import { segmentText } from "../../search/segment.js";
import { tryEmbed, type LlmContext } from "./llm.js";
import { ENTRY_OWNER } from "./runtime-types.js";
import type { EntryRecord } from "./store.js";

/** Entry retrieval index: summary / name vectors (sync, per item) and body chunks (after the batch). */

export type IndexContext = { db: DatabaseSync; searchIndex: SearchIndex | null; llm: LlmContext };

function summaryText(entry: EntryRecord): string {
  return [entry.name, entry.aliases.join(" / "), entry.summary ?? ""].filter(Boolean).join("\n");
}

function nameText(entry: EntryRecord): string {
  return [entry.name, ...entry.aliases].join(" / ");
}

/**
 * `SearchIndex.deleteOwner` issues a plain DELETE on the contentless FTS5 tables, which SQLite rejects
 * ("cannot DELETE from contentless fts5 table"). Contentless rows must be removed with the FTS5 'delete'
 * command and the originally indexed values, so owners are cleared here before re-indexing.
 */
export function clearOwner(db: DatabaseSync, searchIndex: SearchIndex, ownerType: string, ownerId: string): void {
  const rows = db.prepare("SELECT rowid, text FROM chunks WHERE owner_type = ? AND owner_id = ?").all(ownerType, ownerId) as Array<{
    rowid: number;
    text: string;
  }>;
  if (rows.length === 0) return;
  const deleteFts = db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, seg_text) VALUES ('delete', ?, ?)");
  const deleteTrigram = db.prepare("INSERT INTO chunks_trigram(chunks_trigram, rowid, text) VALUES ('delete', ?, ?)");
  for (const row of rows) {
    const rowid = Number(row.rowid);
    deleteFts.run(rowid, segmentText(row.text));
    deleteTrigram.run(rowid, row.text.toLowerCase());
    searchIndex.vectorStore.delete(rowid);
  }
  db.prepare("DELETE FROM chunks WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
}

async function indexOwner(
  ctx: IndexContext & { searchIndex: SearchIndex },
  ownerType: string,
  ownerId: string,
  text: string,
  embedding?: number[] | number[][]
) {
  clearOwner(ctx.db, ctx.searchIndex, ownerType, ownerId);
  await ctx.searchIndex.indexDocument({ ownerType, ownerId, text }, embedding);
}

export async function indexEntrySummary(ctx: IndexContext, entry: EntryRecord): Promise<void> {
  if (!ctx.searchIndex) return;
  const indexCtx = { ...ctx, searchIndex: ctx.searchIndex };
  const summary = summaryText(entry);
  const name = nameText(entry);
  const summaryVector = await tryEmbed(ctx.llm, summary);
  await indexOwner(indexCtx, ENTRY_OWNER.summary, entry.id, summary, summaryVector ?? undefined);
  const nameVector = await tryEmbed(ctx.llm, name);
  await indexOwner(indexCtx, ENTRY_OWNER.name, entry.id, name, nameVector ?? undefined);
}

export async function indexEntryBody(ctx: IndexContext, entry: EntryRecord): Promise<void> {
  if (!ctx.searchIndex) return;
  const indexCtx = { ...ctx, searchIndex: ctx.searchIndex };
  const text = entry.body.trim();
  if (!text) {
    clearOwner(ctx.db, ctx.searchIndex, ENTRY_OWNER.body, entry.id);
    return;
  }
  const vectors: number[][] = [];
  let complete = true;
  for (const part of chunkText(text)) {
    const vector = await tryEmbed(ctx.llm, part.text);
    if (!vector) {
      complete = false;
      break;
    }
    vectors.push(vector);
  }
  await indexOwner(indexCtx, ENTRY_OWNER.body, entry.id, text, complete && vectors.length ? vectors : undefined);
}

/** Cosine similarity from an L2 distance between unit vectors. */
export function cosineFromL2(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
}

/** Vector KNN over entry chunks of the given owner types → best similarity per entry. */
export function vectorRecall(ctx: IndexContext, embedding: number[], ownerTypes: string[], k = 30): Map<string, number> {
  const out = new Map<string, number>();
  if (!ctx.searchIndex || ctx.searchIndex.vectorStore.size() === 0) return out;
  if (embedding.length !== ctx.searchIndex.vectorStore.dimensions) return out;
  const select = ctx.db.prepare("SELECT owner_type, owner_id FROM chunks WHERE rowid = ?");
  for (const hit of ctx.searchIndex.vectorStore.search(embedding, k)) {
    const row = select.get(hit.rowid) as { owner_type: string; owner_id: string } | undefined;
    if (!row || !ownerTypes.includes(row.owner_type)) continue;
    const similarity = cosineFromL2(hit.distance);
    if (similarity > (out.get(row.owner_id) ?? -1)) out.set(row.owner_id, similarity);
  }
  return out;
}
