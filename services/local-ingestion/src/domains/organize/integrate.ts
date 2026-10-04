import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sourceKindOf, type OrganizeRunEntryChange } from "@study-studio/shared";
import type { KnowledgeProcessingOutput, PointImportance } from "../../ai/prompts/schemas.draft.js";
import { withTransaction } from "../../db/database.js";
import { normalizeKind } from "../kb/queries.js";
import { decideAlignment, demoteNewBodyToSupplement } from "./align.js";
import { kindVocabulary, resolveKind } from "./kinds.js";
import { normalizeEntryName } from "./normalize.js";
import { applyPatchOps } from "./patch.js";
import { findEntryByName, listAliveEntries, loadEntry, type EntryRecord, type OrganizeItem } from "./store.js";
import type { PatchOp } from "./types.js";

/** ⑥ Knowledge Integration: one transaction per work unit (KB writes + organize_results + inbox status). */

export type StoredEvidence = { quote: string; question?: string; turnItemId?: string; point?: string; importance?: PointImportance };
type ModelEvidence = { quote: string; question?: string | null; turn_item_id?: string | null; point?: string | null; importance?: PointImportance | null };

export type EntryChange = { entryId: string; name: string; change: OrganizeRunEntryChange["change"] };

export type ResultRecord = {
  decision: "new" | "supplement" | "duplicate" | "reject" | "not_learning";
  route: string;
  valueScore: number | null;
  rejectReason: string | null;
  reason: string | null;
  summary: string | null;
  points: string[] | null;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  episodeId: string | null;
  override: "adopt" | null;
  /** Extra JSON merged into `organize_results.output`. */
  output: Record<string, unknown> | null;
};

export type IntegrationContext = {
  db: DatabaseSync;
  runId: string;
  now: string;
  kbIgnore: string[];
  /** Concept name → precomputed name-embedding similarities (threshold applied in `decideAlignment`). */
  nameSimilarities: Map<string, Array<{ entry_id: string; similarity: number }>>;
  /** Note ids consumed by this unit (`notes.used_at`). */
  usedNoteIds: string[];
};

export type IntegrationResult = {
  status: "ingested" | "rejected";
  entryChanges: EntryChange[];
  edgesCreated: number;
  touchedEntryIds: string[];
};

function toStoredEvidence(evidence: ModelEvidence): StoredEvidence {
  return {
    quote: evidence.quote,
    ...(evidence.question ? { question: evidence.question } : {}),
    ...(evidence.turn_item_id ? { turnItemId: evidence.turn_item_id } : {}),
    ...(evidence.point ? { point: evidence.point } : {}),
    ...(evidence.importance ? { importance: evidence.importance } : {})
  };
}

function resolveCategory(db: DatabaseSync, name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const rows = db.prepare("SELECT id, name FROM kb_categories").all() as Array<{ id: string; name: string | null }>;
  const hit = rows.find((row) => row.name && normalizeEntryName(row.name) === normalizeEntryName(trimmed));
  if (hit) return hit.id;
  const id = randomUUID();
  const sort = (db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM kb_categories").get() as { next: number }).next;
  db.prepare("INSERT INTO kb_categories(id, name, description, sort) VALUES (?, ?, NULL, ?)").run(id, trimmed, sort);
  return id;
}

/** Collects (entry, source item) evidence for one unit, written once at the end. */
class SourceBuffer {
  private readonly rows = new Map<string, { entryId: string; itemId: string; evidence: StoredEvidence[] }>();

  constructor(private readonly items: OrganizeItem[]) {}

  add(entryId: string, evidence: ModelEvidence[]): void {
    const anchor = this.items[0]!;
    const known = new Set(this.items.map((item) => item.id));
    const list = evidence.length ? evidence : [{ quote: anchor.highlights[0] ?? anchor.title }];
    for (const entry of list) {
      const itemId = entry.turn_item_id && known.has(entry.turn_item_id) ? entry.turn_item_id : anchor.id;
      const key = `${entryId}\0${itemId}`;
      const row = this.rows.get(key) ?? { entryId, itemId, evidence: [] };
      const stored = toStoredEvidence(entry);
      if (!row.evidence.some((existing) => existing.quote === stored.quote)) row.evidence.push(stored);
      this.rows.set(key, row);
    }
  }

  flush(db: DatabaseSync, now: string): void {
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const upsert = db.prepare(
      `INSERT INTO kb_entry_sources(entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entry_id, item_id) DO UPDATE SET evidence = excluded.evidence, source_kind = excluded.source_kind, added_at = excluded.added_at`
    );
    for (const row of this.rows.values()) {
      const item = byId.get(row.itemId)!;
      upsert.run(row.entryId, row.itemId, JSON.stringify(row.evidence), sourceKindOf(item.type, item.url), now);
    }
  }
}

function insertEntry(
  db: DatabaseSync,
  concept: {
    name: string;
    aliases: string[];
    kind: string;
    category: string | null;
    summary: string | null;
    body_markdown: string | null;
    completeness: unknown;
  },
  now: string
): EntryRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO kb_entries(id, name, category_id, kind, aliases, summary, body_markdown, completeness, mastery, mastery_source, user_edited, stale, orphan, patch_count, dirty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'auto', 0, 0, 0, 0, 0, ?)`
  ).run(
    id,
    concept.name.trim(),
    resolveCategory(db, concept.category),
    concept.kind,
    JSON.stringify([...new Set(concept.aliases.map((alias) => alias.trim()).filter(Boolean))]),
    concept.summary ?? "",
    concept.body_markdown ?? "",
    concept.completeness ? JSON.stringify(concept.completeness) : null,
    now
  );
  return loadEntry(db, id)!;
}

type PatchApplied = { replaced: Array<{ section: string; previous_markdown: string }>; degraded: number; suggestion: boolean };

function patchEntry(
  db: DatabaseSync,
  entryId: string,
  ops: PatchOp[],
  extra: { summary?: string | null; completeness?: unknown; addAlias?: string },
  now: string
): PatchApplied | null {
  const entry = loadEntry(db, entryId);
  if (!entry) return null;
  const applied = applyPatchOps({ body_markdown: entry.body, ops, user_edited: entry.userEdited, patch_count: entry.patchCount });
  const aliases =
    extra.addAlias && !entry.aliases.some((alias) => normalizeEntryName(alias) === normalizeEntryName(extra.addAlias!))
      ? [...entry.aliases, extra.addAlias]
      : entry.aliases;
  const summary = !entry.userEdited && extra.summary ? extra.summary : entry.summary;
  const completeness = extra.completeness ? JSON.stringify(extra.completeness) : entry.completeness;
  db.prepare("UPDATE kb_entries SET body_markdown = ?, patch_count = ?, summary = ?, completeness = ?, aliases = ?, updated_at = ? WHERE id = ?").run(
    applied.body_markdown,
    applied.patch_count,
    summary,
    completeness,
    JSON.stringify(aliases),
    now,
    entryId
  );
  return { replaced: applied.replaced_sections, degraded: applied.degraded_ops.length, suggestion: applied.wrote_suggestion };
}

function addAlias(db: DatabaseSync, entryId: string, alias: string | undefined): void {
  if (!alias) return;
  const entry = loadEntry(db, entryId);
  if (!entry || entry.aliases.some((existing) => normalizeEntryName(existing) === normalizeEntryName(alias))) return;
  db.prepare("UPDATE kb_entries SET aliases = ? WHERE id = ?").run(JSON.stringify([...entry.aliases, alias]), entryId);
}

function insertEdge(db: DatabaseSync, src: string, dst: string, type: string, itemId: string, description: string | null): boolean {
  const created = Number(db.prepare("INSERT OR IGNORE INTO kb_edges(src, dst, type) VALUES (?, ?, ?)").run(src, dst, type).changes) > 0;
  db.prepare("DELETE FROM kb_edge_sources WHERE src = ? AND dst = ? AND type = ? AND item_id = ?").run(src, dst, type, itemId);
  db.prepare("INSERT INTO kb_edge_sources(src, dst, type, item_id, description) VALUES (?, ?, ?, ?, ?)").run(src, dst, type, itemId, description);
  return created;
}

export function writeResults(db: DatabaseSync, items: OrganizeItem[], record: ResultRecord, runId: string, now: string, targetEntryIds: string[]): void {
  const upsert = db.prepare(
    `INSERT INTO organize_results(item_id, summary, points, model, prompt_version, input_hash, run_id, updated_at, episode_id, decision, route, value_score, target_entry_ids, output, reject_reason, reason, override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET summary = excluded.summary, points = excluded.points, model = excluded.model, prompt_version = excluded.prompt_version,
       input_hash = excluded.input_hash, run_id = excluded.run_id, updated_at = excluded.updated_at, episode_id = excluded.episode_id, decision = excluded.decision,
       route = excluded.route, value_score = excluded.value_score, target_entry_ids = excluded.target_entry_ids, output = excluded.output,
       reject_reason = excluded.reject_reason, reason = excluded.reason, override = excluded.override`
  );
  const status = record.decision === "reject" || record.decision === "not_learning" ? "rejected" : "ingested";
  for (const item of items) {
    upsert.run(
      item.id,
      record.summary,
      record.points ? JSON.stringify(record.points) : null,
      record.model,
      record.promptVersion,
      record.inputHash,
      runId,
      now,
      record.episodeId,
      record.decision,
      record.route,
      record.valueScore,
      JSON.stringify(targetEntryIds),
      record.output ? JSON.stringify(record.output) : null,
      record.rejectReason,
      record.reason,
      record.override
    );
    db.prepare("UPDATE items SET organize_status = ?, dirty = 0 WHERE id = ?").run(status, item.id);
  }
}

function markNotesUsed(db: DatabaseSync, noteIds: string[], now: string): void {
  const update = db.prepare("UPDATE notes SET used_at = ? WHERE id = ?");
  for (const id of new Set(noteIds)) update.run(now, id);
}

function aliveTargets(db: DatabaseSync, ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => loadEntry(db, id));
}

/** Rejections (judge `not_learning`, prefilter / ⑤ `reject`): results + status only. */
export function recordRejection(ctx: IntegrationContext, items: OrganizeItem[], record: ResultRecord): IntegrationResult {
  withTransaction(ctx.db, () => {
    writeResults(ctx.db, items, record, ctx.runId, ctx.now, []);
    markNotesUsed(ctx.db, ctx.usedNoteIds, ctx.now);
  });
  return { status: "rejected", entryChanges: [], edgesCreated: 0, touchedEntryIds: [] };
}

/** Duplicates (prefilter rule or ⑤): attach sources + evidence only. */
export function recordDuplicate(
  ctx: IntegrationContext,
  items: OrganizeItem[],
  evidenceByEntry: Array<{ entryId: string; evidence: ModelEvidence[] }>,
  record: ResultRecord
): IntegrationResult {
  return withTransaction(ctx.db, () => {
    const targets = aliveTargets(
      ctx.db,
      evidenceByEntry.map((entry) => entry.entryId)
    );
    if (targets.length === 0) throw new Error("duplicate targets no longer exist");
    const buffer = new SourceBuffer(items);
    for (const entry of evidenceByEntry) if (targets.includes(entry.entryId)) buffer.add(entry.entryId, entry.evidence);
    buffer.flush(ctx.db, ctx.now);
    const entryChanges = targets.map((entryId) => ({ entryId, name: loadEntry(ctx.db, entryId)!.name, change: "duplicate" as const }));
    writeResults(ctx.db, items, { ...record, output: { ...record.output, entry_changes: entryChanges } }, ctx.runId, ctx.now, targets);
    markNotesUsed(ctx.db, ctx.usedNoteIds, ctx.now);
    return { status: "ingested" as const, entryChanges, edgesCreated: 0, touchedEntryIds: [] };
  });
}

type Extraction = Extract<KnowledgeProcessingOutput, { decision: "new" | "supplement" }>;

/** `new` / `supplement`: align concepts, create entries / apply patches, sources, relations, results. */
export function integrateExtraction(ctx: IntegrationContext, items: OrganizeItem[], output: Extraction, record: ResultRecord): IntegrationResult {
  return withTransaction(ctx.db, () => {
    const db = ctx.db;
    const anchor = items[0]!;
    const buffer = new SourceBuffer(items);
    const changes = new Map<string, EntryChange>();
    const nameToId = new Map<string, string>();
    const replaced: Array<{ entryId: string; section: string; previous_markdown: string }> = [];
    const discarded: string[] = [];
    let degraded = 0;
    let edgesCreated = 0;

    const setChange = (entryId: string, change: EntryChange["change"]) => {
      const previous = changes.get(entryId);
      if (previous?.change === "created") return;
      if (previous?.change === "supplemented" && change === "duplicate") return;
      changes.set(entryId, { entryId, name: loadEntry(db, entryId)?.name ?? entryId, change });
    };

    const kinds = kindVocabulary(db);

    for (const concept of output.concepts) {
      const entries = listAliveEntries(db);
      const isNew = concept.match === "new";
      const kind = resolveKind(concept.kind, kinds);
      const decision = decideAlignment({
        match: concept.match,
        name: concept.name,
        aliases: concept.aliases,
        kind,
        body_markdown: isNew ? concept.body_markdown : null,
        existing_entries: entries.map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases, kind: normalizeKind(entry.kind) })),
        kb_ignore_names: ctx.kbIgnore,
        name_similarities: ctx.nameSimilarities.get(concept.name) ?? []
      });
      if (decision.action === "discard") {
        discarded.push(concept.name);
        continue;
      }

      let entryId: string;
      if (decision.action === "create_new") {
        if (!kinds.includes(kind)) kinds.push(kind);
        const created = insertEntry(
          db,
          {
            name: concept.name,
            aliases: concept.aliases,
            kind,
            category: concept.category,
            summary: concept.summary,
            body_markdown: concept.body_markdown ?? (concept.patch ? concept.patch.ops.map((op) => op.markdown).join("\n\n") : ""),
            completeness: concept.completeness ?? concept.patch?.completeness ?? null
          },
          ctx.now
        );
        entryId = created.id;
        setChange(entryId, "created");
      } else {
        entryId = decision.entry_id;
        const ops: PatchOp[] = [];
        if (decision.demote_body_to_supplement && concept.body_markdown) ops.push(demoteNewBodyToSupplement(concept.body_markdown));
        else if (concept.patch) ops.push(...concept.patch.ops);
        if (ops.length) {
          const applied = patchEntry(
            db,
            entryId,
            ops,
            { summary: concept.patch?.summary, completeness: concept.patch?.completeness, addAlias: decision.add_alias },
            ctx.now
          );
          if (applied) {
            replaced.push(...applied.replaced.map((section) => ({ entryId, ...section })));
            degraded += applied.degraded;
            setChange(entryId, "supplemented");
          }
        } else {
          addAlias(db, entryId, decision.add_alias);
          setChange(entryId, "duplicate");
        }
      }
      buffer.add(entryId, concept.evidence);
      for (const name of [concept.name, ...concept.aliases]) nameToId.set(normalizeEntryName(name), entryId);
    }

    const resolve = (name: string): string | undefined => nameToId.get(normalizeEntryName(name)) ?? findEntryByName(listAliveEntries(db), name)?.id;
    for (const relation of output.relations) {
      const src = resolve(relation.from);
      const dst = resolve(relation.to);
      if (!src || !dst || src === dst) continue;
      if (insertEdge(db, src, dst, relation.type, anchor.id, relation.description ?? null)) edgesCreated += 1;
    }

    const entryChanges = [...changes.values()];
    if (entryChanges.length === 0) {
      writeResults(
        db,
        items,
        { ...record, decision: "reject", rejectReason: "ignored", output: { ...record.output, discarded_concepts: discarded } },
        ctx.runId,
        ctx.now,
        []
      );
      markNotesUsed(db, ctx.usedNoteIds, ctx.now);
      return { status: "rejected" as const, entryChanges, edgesCreated, touchedEntryIds: [] };
    }
    buffer.flush(db, ctx.now);
    const touched = entryChanges.filter((change) => change.change !== "duplicate").map((change) => change.entryId);
    writeResults(
      db,
      items,
      {
        ...record,
        output: { ...record.output, entry_changes: entryChanges, replaced_sections: replaced, degraded_ops: degraded, discarded_concepts: discarded }
      },
      ctx.runId,
      ctx.now,
      entryChanges.map((change) => change.entryId)
    );
    markNotesUsed(db, ctx.usedNoteIds, ctx.now);
    return { status: "ingested" as const, entryChanges, edgesCreated, touchedEntryIds: touched };
  });
}
