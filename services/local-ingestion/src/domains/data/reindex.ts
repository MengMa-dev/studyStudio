import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DataReindexResponse } from "@study-studio/shared";
import type { AiGateway } from "../../ai/gateway.js";
import type { IndexableDocument, SearchIndex } from "../../search/index-api.js";

export type ReindexJob = {
  id: string;
  status: DataReindexResponse["status"];
  done: number;
  total: number;
  error: string | null;
  mode: "vector" | "fts" | "none";
};

const jobs = new Map<string, ReindexJob>();
let running: ReindexJob | null = null;

export function getReindexJob(id: string): ReindexJob | undefined {
  return jobs.get(id);
}

/** Live items and entries; content is never modified, only the derived chunks / FTS / vectors. */
export function indexableDocuments(db: DatabaseSync): IndexableDocument[] {
  const items = db
    .prepare(
      `SELECT i.id, i.title, c.markdown, c.plain_text, c.question FROM items i LEFT JOIN item_contents c ON c.item_id = i.id
       WHERE i.deleted_at IS NULL`
    )
    .all() as { id: string; title: string | null; markdown: string | null; plain_text: string | null; question: string | null }[];
  const entries = db.prepare("SELECT id, name, summary, body_markdown FROM kb_entries WHERE deleted_at IS NULL").all() as {
    id: string;
    name: string;
    summary: string | null;
    body_markdown: string | null;
  }[];
  const docs: IndexableDocument[] = [];
  for (const item of items) {
    const text = [item.title, item.question, item.markdown ?? item.plain_text].filter(Boolean).join("\n\n").trim();
    if (text) docs.push({ ownerType: "item", ownerId: item.id, text });
  }
  for (const entry of entries) {
    const text = [entry.name, entry.summary, entry.body_markdown].filter(Boolean).join("\n\n").trim();
    if (text) docs.push({ ownerType: "entry", ownerId: entry.id, text });
  }
  return docs;
}

async function run(job: ReindexJob, db: DatabaseSync, index: SearchIndex, gateway: AiGateway | undefined): Promise<void> {
  const docs = indexableDocuments(db);
  job.total = docs.length;
  job.status = "running";
  try {
    if (gateway) {
      try {
        await index.reindex(
          docs,
          async (text) => (await gateway.embed({ value: text })).embedding,
          (progress) => (job.done = progress.done)
        );
        job.mode = "vector";
        return;
      } catch {
        job.done = 0;
      }
    }
    // Without a working embedding model the rebuild keeps FTS only (vector search degrades to off).
    await index.reindex([], () => []);
    for (const doc of docs) {
      await index.indexDocument(doc);
      job.done += 1;
    }
    job.mode = "fts";
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    job.status = "done";
    running = null;
  }
}

/** Starts a background rebuild, or returns the one already running. Without a search index there is nothing to rebuild. */
export function startReindex(db: DatabaseSync, index: SearchIndex | undefined, gateway: AiGateway | undefined): ReindexJob {
  if (running) return running;
  const job: ReindexJob = { id: randomUUID(), status: index ? "queued" : "done", done: 0, total: 0, error: null, mode: index ? "fts" : "none" };
  jobs.set(job.id, job);
  while (jobs.size > 20) jobs.delete(jobs.keys().next().value!);
  if (!index) return job;
  running = job;
  setImmediate(() => void run(job, db, index, gateway));
  return job;
}
