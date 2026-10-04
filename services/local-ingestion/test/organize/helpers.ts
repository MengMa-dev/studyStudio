import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { AiGateway } from "../../src/ai/gateway";
import { MemoryProviderConfigStore, MemoryUsageStore } from "../../src/ai/stores";
import type { AiTask, LlmFixture, MockRule } from "../../src/ai/types";
import { openDatabase, type AppDatabase } from "../../src/db/database";
import { executeRun, type PipelineResult } from "../../src/domains/organize/pipeline";
import { createRun, type RunSpec } from "../../src/domains/organize/run-store";
import { createSearchIndex, type SearchIndex } from "../../src/search/index-api";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/llm");

export const NOW = new Date("2026-10-02T23:00:00+08:00");

export type FixtureTask = "learning_judge" | "knowledge_processing" | "entry_rewrite";

export function fixture(task: FixtureTask, name: string): LlmFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, task, `${name}.json`), "utf8")) as LlmFixture;
}

/** Recorded output (deep copy) with optional overrides. */
export function output<T = Record<string, unknown>>(task: FixtureTask, name: string, patch: Partial<T> = {}): T {
  return { ...(structuredClone(fixture(task, name).output) as T), ...patch };
}

/** Item content from the recorded ⑤ input (exposure annotations stripped). */
export function recordedContent(name: string): string {
  const input = fixture("knowledge_processing", name).input as { item: { content?: string } };
  return (input.item.content ?? "").replace(/ \[露出:[^\]]+\]/g, "");
}

export function recordedTurns(name: string): Array<{ turn_item_id: string; question: string; answer: string }> {
  const input = fixture("knowledge_processing", name).input as { item: { turns?: Array<{ turn_item_id: string; question: string; answer: string }> } };
  return input.item.turns ?? [];
}

export type Input = Record<string, unknown> & {
  step?: "triage" | "extract" | "compose";
  item?: { item_id?: string };
  entry?: { entry_id?: string };
  chunk?: { index: number };
  timeline?: unknown[];
  mode?: string;
  feedback?: string[] | null;
};

const stepRule =
  (step: NonNullable<Input["step"]>) =>
  (itemId: string, out: unknown, when: (input: Input) => boolean = () => true): MockRule => ({
    match: ({ input }) => (input as Input)?.step === step && (input as Input).item?.item_id === itemId && when(input as Input),
    output: out
  });

/** Replay rules keyed on the task input shape (pipeline inputs differ from recorded ones, so `task:inputHash` lookups never hit). */
export const replay = {
  judge(out: unknown, when: (input: Input) => boolean = () => true): MockRule {
    return { match: ({ input }) => Array.isArray((input as Input)?.timeline) && when(input as Input), output: out };
  },
  triage: stepRule("triage"),
  extract: stepRule("extract"),
  compose: stepRule("compose"),
  rewrite(entryId: string, out: unknown, when: (input: Input) => boolean = () => true): MockRule {
    return {
      match: ({ input }) => (input as Input)?.entry?.entry_id === entryId && "evidence" in (input as Input) && when(input as Input),
      output: { covered_ids: Array.from({ length: 100 }, (_, index) => `e${index + 1}`), dropped: [], ...(out as object) }
    };
  }
};

type RecordedEvidence = { quote: string; question?: string | null; turn_item_id?: string | null };
type RecordedConcept = Record<string, unknown> & { name: string; match: string; evidence: RecordedEvidence[] };
type RecordedOutput = Record<string, unknown> & {
  decision: "new" | "supplement" | "duplicate" | "reject";
  value_score: number;
  reason: string;
  reject_reason?: string;
  item_summary?: string;
  item_points?: string[];
  concepts?: RecordedConcept[];
  relations?: unknown[];
  target_entry_ids?: string[];
  evidence_by_entry?: Array<{ entry_id: string; evidence: RecordedEvidence[] }>;
};

/**
 * Splits a recorded single-call ⑤ output into S1 triage / S2 extract (all points in chunk 0) / S3+S4 compose replays.
 * Every evidence quote becomes one core point; duplicates become existing-entry concepts with `patch: null`.
 */
export function steps(itemId: string, data: unknown, options: { duplicateAtTriage?: boolean } = {}): MockRule[] {
  const recorded = data as RecordedOutput;
  const triage = {
    item_id: itemId,
    decision: recorded.decision === "new" || recorded.decision === "supplement" ? "proceed" : recorded.decision,
    value_score: recorded.value_score,
    reason: recorded.reason,
    reject_reason: recorded.decision === "reject" ? (recorded.reject_reason ?? "low_information") : null,
    target_entry_ids: recorded.decision === "duplicate" && options.duplicateAtTriage !== false ? (recorded.target_entry_ids ?? []) : [],
    duplicate_quotes: recorded.decision === "duplicate" ? (recorded.evidence_by_entry ?? []).flatMap((entry) => entry.evidence.map((item) => item.quote)) : [],
    thesis: recorded.item_summary ?? recorded.reason,
    user_focus: []
  };
  const rules = [replay.triage(itemId, triage)];
  if (recorded.decision === "reject") return rules;

  const groups: Array<{ concept: RecordedConcept; evidence: RecordedEvidence[] }> =
    recorded.decision === "duplicate"
      ? (recorded.evidence_by_entry ?? []).map((entry) => ({
          concept: { name: entry.entry_id, match: entry.entry_id, aliases: [], kind: "概念", evidence: entry.evidence, patch: null },
          evidence: entry.evidence
        }))
      : (recorded.concepts ?? []).map((concept) => ({ concept, evidence: concept.evidence }));
  let next = 0;
  const points: Array<Record<string, unknown>> = [];
  const concepts = groups.map(({ concept, evidence }) => {
    const { evidence: _evidence, ...rest } = concept;
    const point_ids = evidence.map((item) => {
      next += 1;
      points.push({ statement: item.quote, quote: item.quote, section: null, concept: concept.name, importance: "core", turn_item_id: item.turn_item_id ?? null });
      return `p${next}`;
    });
    return { category: null, summary: null, body_markdown: null, completeness: null, patch: null, ...rest, point_ids };
  });
  return [
    ...rules,
    replay.extract(itemId, { points }, (input) => input.chunk?.index === 0),
    replay.extract(itemId, { points: [] }),
    replay.compose(itemId, {
      item_summary: recorded.item_summary ?? recorded.reason,
      item_points: recorded.item_points ?? [],
      concepts,
      relations: recorded.relations ?? [],
      dropped: []
    })
  ];
}

export function stepCalls(prompts: Array<{ input: unknown }>, step: NonNullable<Input["step"]>, itemId?: string): Input[] {
  return prompts.map((call) => call.input as Input).filter((input) => input?.step === step && (!itemId || input.item?.item_id === itemId));
}

export type ReplayGateway = { gateway: AiGateway; config: MemoryProviderConfigStore; usage: MemoryUsageStore; prompts: Array<{ input: unknown }> };

export function createReplayGateway(rules: MockRule[], options: { limit?: number | null } = {}): ReplayGateway {
  const config = new MemoryProviderConfigStore();
  const usage = new MemoryUsageStore();
  config.upsertProvider({ id: "mock", name: "Mock", type: "mock", baseUrl: null, defaultModel: "replay" });
  const tasks: AiTask[] = ["learning_judge", "knowledge_processing", "entry_rewrite", "embedding"];
  for (const task of tasks) config.setTaskModel({ task, providerId: "mock", model: "replay", fallbackProviderId: null, fallbackModel: null });
  if (options.limit !== undefined) config.setDailyTokenLimit(options.limit);
  const prompts: Array<{ input: unknown }> = [];
  const recorder: MockRule = {
    match: ({ input }) => {
      prompts.push({ input });
      return false;
    },
    output: null
  };
  const gateway = new AiGateway({
    configStore: config,
    usageStore: usage,
    mock: { rules: [recorder, ...rules] },
    retry: { retries: 0, baseDelayMs: 1, sleep: async () => {} },
    nowDay: () => "2026-10-02"
  });
  return { gateway, config, usage, prompts };
}

export type TestEnv = { app: AppDatabase; db: DatabaseSync; searchIndex: SearchIndex };

export function createEnv(): TestEnv {
  const app = openDatabase({ memory: true, skipVector: true });
  const searchIndex = createSearchIndex(app.db, { forceMemory: true, dimensions: 768 });
  return { app, db: app.db, searchIndex };
}

export function setLearnerProfile(db: DatabaseSync): void {
  db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('learner_profile', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ role: "前端开发", directions: [{ id: "dir_agent", text: "Agent 架构", expiresAt: "2026-11-01" }] }),
    NOW.toISOString()
  );
}

export type ItemSeed = {
  id: string;
  type?: "webpage" | "conversation";
  title: string;
  url?: string | null;
  capturedAt: string;
  markdown: string;
  question?: string | null;
  conversationId?: string;
  readingSeconds?: number;
  status?: string;
  dirty?: boolean;
};

export function insertItem(db: DatabaseSync, seed: ItemSeed): void {
  const type = seed.type ?? "webpage";
  db.prepare(
    `INSERT INTO items(id, type, title, url, canonical_url, site, captured_at, organize_status, dirty, content_hash, reading_total_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    type,
    seed.title,
    seed.url ?? null,
    type === "webpage" ? (seed.url ?? `https://example.test/${seed.id}`) : null,
    seed.url ? new URL(seed.url).hostname : null,
    seed.capturedAt,
    seed.status ?? "pending",
    seed.dirty ? 1 : 0,
    `hash_${seed.id}`,
    seed.readingSeconds ?? 600
  );
  db.prepare("INSERT INTO item_contents(item_id, markdown, plain_text, question, meta) VALUES (?, ?, ?, ?, ?)").run(
    seed.id,
    seed.markdown,
    seed.markdown,
    seed.question ?? null,
    seed.conversationId ? JSON.stringify({ conversationId: seed.conversationId }) : null
  );
}

export type EntrySeed = {
  id: string;
  name: string;
  aliases?: string[];
  kind?: string;
  summary?: string;
  body: string;
  userEdited?: boolean;
  patchCount?: number;
  updatedAt?: string;
  category?: string;
};

export function insertEntry(db: DatabaseSync, seed: EntrySeed): void {
  let categoryId: string | null = null;
  if (seed.category) {
    categoryId = `cat_${seed.category}`;
    db.prepare("INSERT OR IGNORE INTO kb_categories(id, name, sort) VALUES (?, ?, 0)").run(categoryId, seed.category);
  }
  db.prepare(
    `INSERT INTO kb_entries(id, name, category_id, kind, aliases, summary, body_markdown, completeness, user_edited, stale, orphan, patch_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?)`
  ).run(
    seed.id,
    seed.name,
    categoryId,
    seed.kind ?? "concept",
    JSON.stringify(seed.aliases ?? []),
    seed.summary ?? `${seed.name} 摘要`,
    seed.body,
    seed.userEdited ? 1 : 0,
    seed.patchCount ?? 0,
    seed.updatedAt ?? "2026-10-01T00:00:00.000Z"
  );
}

export function insertSource(db: DatabaseSync, entryId: string, itemId: string, quotes: string[], addedAt = "2026-10-01T00:00:00.000Z"): void {
  db.prepare("INSERT INTO kb_entry_sources(entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, 'official_doc', ?)").run(
    entryId,
    itemId,
    JSON.stringify(quotes.map((quote) => ({ quote }))),
    addedAt
  );
}

export function insertNote(
  db: DatabaseSync,
  note: { id: string; scope: "item" | "entry" | "fuzzy"; targetId?: string | null; text: string; createdAt: string }
): void {
  db.prepare("INSERT INTO notes(id, scope, target_id, text, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?)").run(
    note.id,
    note.scope,
    note.targetId ?? null,
    note.text,
    note.createdAt,
    note.createdAt
  );
}

export function insertSelection(db: DatabaseSync, itemId: string, text: string, occurredAt: string): void {
  db.prepare("INSERT INTO events(id, type, occurred_at, day, item_id, payload, received_at) VALUES (?, 'selection', ?, ?, ?, ?, ?)").run(
    `sel_${itemId}_${occurredAt}`,
    occurredAt,
    occurredAt.slice(0, 10),
    itemId,
    JSON.stringify({ snippet: { text } }),
    occurredAt
  );
}

export async function runPipeline(env: TestEnv, gateway: AiGateway, spec: Partial<RunSpec> = {}): Promise<{ runId: string; result: PipelineResult }> {
  const full: RunSpec = { trigger: "manual", scope: null, itemIds: [], entryIds: [], requirement: null, allowOverLimit: false, ...spec };
  const run = createRun(env.db, full);
  const result = await executeRun({ db: env.db, gateway, searchIndex: env.searchIndex, now: () => NOW }, run.id, full);
  return { runId: run.id, result };
}

export function itemStatus(db: DatabaseSync, id: string): { organize_status: string; dirty: number } {
  return db.prepare("SELECT organize_status, dirty FROM items WHERE id = ?").get(id) as { organize_status: string; dirty: number };
}

export function result(db: DatabaseSync, itemId: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM organize_results WHERE item_id = ?").get(itemId) as Record<string, unknown> | undefined;
}

export function entry(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}
