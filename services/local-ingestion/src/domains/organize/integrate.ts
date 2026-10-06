import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendSections, attachSectionSources, sourceKindOf, type OrganizeRunEntryChange } from "@study-studio/shared";
import { withTransaction } from "../../db/database.js";
import { normalizeKind } from "../kb/queries.js";
import { decideAlignment } from "./align.js";
import { resolveKind } from "./kinds.js";
import { normalizeEntryName } from "./normalize.js";
import { findEntryByName, listAliveEntries, loadEntry, parseJson, type OrganizeItem } from "./store.js";
import { entrySections, verbatimRatio, VERBATIM_MIN_RATIO, type AlignedFragment, type ProcessingResult } from "./verify.js";

/** ⑥ Knowledge Integration: one transaction per work unit (KB writes + organize_results + inbox status). */

/** `kb_entry_sources.evidence` row: section-level (17) or a quote (prefilter duplicates / legacy). */
export type StoredEvidence = { quote: string; section_id?: string | null; heading?: string; question?: string; turnItemId?: string };
type ModelEvidence = { quote: string; question?: string | null; turn_item_id?: string | null };

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

const sameEvidence = (a: StoredEvidence, b: StoredEvidence) => (a.section_id ? b.section_id === a.section_id : b.quote === a.quote);

/** Collects (entry, source item) evidence for one unit, merged into the stored rows at the end. */
class SourceBuffer {
  private readonly rows = new Map<string, { entryId: string; itemId: string; evidence: StoredEvidence[] }>();

  constructor(private readonly items: OrganizeItem[]) {}

  /** Unknown / missing turn ids fall back to the anchor item. */
  itemIdOf(turnItemId: string | null | undefined): string {
    return turnItemId && this.items.some((item) => item.id === turnItemId) ? turnItemId : this.items[0]!.id;
  }

  add(entryId: string, itemId: string, stored: StoredEvidence): void {
    const key = `${entryId}\0${itemId}`;
    const row = this.rows.get(key) ?? { entryId, itemId, evidence: [] };
    if (!row.evidence.some((existing) => sameEvidence(stored, existing))) row.evidence.push(stored);
    this.rows.set(key, row);
  }

  /** Conversation turns also carry the question so the source card can show it and link the turn. */
  addSection(entryId: string, itemId: string, sectionId: string | null, heading: string): void {
    const item = this.items.find((candidate) => candidate.id === itemId)!;
    this.add(entryId, itemId, {
      section_id: sectionId,
      heading,
      quote: heading,
      ...(item.type === "conversation" ? { question: item.question ?? item.title, turnItemId: item.id } : {})
    });
  }

  addQuotes(entryId: string, evidence: ModelEvidence[]): void {
    const anchor = this.items[0]!;
    const list = evidence.length ? evidence : [{ quote: anchor.highlights[0] ?? anchor.title }];
    for (const entry of list) {
      this.add(entryId, this.itemIdOf(entry.turn_item_id), {
        quote: entry.quote,
        ...(entry.question ? { question: entry.question } : {}),
        ...(entry.turn_item_id ? { turnItemId: entry.turn_item_id } : {})
      });
    }
  }

  flush(db: DatabaseSync, now: string): void {
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const select = db.prepare("SELECT evidence FROM kb_entry_sources WHERE entry_id = ? AND item_id = ?");
    const upsert = db.prepare(
      `INSERT INTO kb_entry_sources(entry_id, item_id, evidence, source_kind, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entry_id, item_id) DO UPDATE SET evidence = excluded.evidence, source_kind = excluded.source_kind, added_at = excluded.added_at`
    );
    for (const row of this.rows.values()) {
      const item = byId.get(row.itemId)!;
      const stored = parseJson<unknown>((select.get(row.entryId, row.itemId) as { evidence: string | null } | undefined)?.evidence, []);
      const kept = (Array.isArray(stored) ? (stored as StoredEvidence[]) : []).filter(
        (existing) => !row.evidence.some((added) => sameEvidence(added, existing))
      );
      upsert.run(row.entryId, row.itemId, JSON.stringify([...kept, ...row.evidence]), sourceKindOf(item.type, item.url), now);
    }
  }
}

function insertEntry(
  db: DatabaseSync,
  entry: { name: string; aliases: string[]; kind: string; category: string | null; summary: string | null; body_markdown: string },
  now: string
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO kb_entries(id, name, category_id, kind, aliases, summary, body_markdown, completeness, mastery, mastery_source, user_edited, stale, orphan, patch_count, dirty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'auto', 0, 0, 0, 0, 0, ?)`
  ).run(
    id,
    entry.name.trim(),
    resolveCategory(db, entry.category),
    entry.kind,
    JSON.stringify([...new Set(entry.aliases.map((alias) => alias.trim()).filter(Boolean))]),
    entry.summary ?? "",
    entry.body_markdown,
    now
  );
  return id;
}

function withAlias(aliases: string[], alias: string | undefined): string[] {
  if (!alias || aliases.some((existing) => normalizeEntryName(existing) === normalizeEntryName(alias))) return aliases;
  return [...aliases, alias];
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

/** Prefilter duplicates: attach sources (quote evidence) only. */
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
    for (const entry of evidenceByEntry) if (targets.includes(entry.entryId)) buffer.addQuotes(entry.entryId, entry.evidence);
    buffer.flush(ctx.db, ctx.now);
    const entryChanges = targets.map((entryId) => ({ entryId, name: loadEntry(ctx.db, entryId)!.name, change: "duplicate" as const }));
    writeResults(ctx.db, items, { ...record, output: { ...record.output, entry_changes: entryChanges } }, ctx.runId, ctx.now, targets);
    markNotesUsed(ctx.db, ctx.usedNoteIds, ctx.now);
    return { status: "ingested" as const, entryChanges, edgesCreated: 0, touchedEntryIds: [] };
  });
}

type Aligned = Exclude<ProcessingResult, { decision: "reject" }>;

/** Fragments grouped by target (`entry` id or new key), in original order. */
function groupByTarget(fragments: AlignedFragment[]): Array<{ target: string; fragments: AlignedFragment[] }> {
  const groups = new Map<string, AlignedFragment[]>();
  for (const fragment of fragments) groups.set(fragment.entry, [...(groups.get(fragment.entry) ?? []), fragment]);
  return [...groups].map(([target, list]) => ({ target, fragments: list }));
}

/**
 * `new` / `supplement` / `duplicate` (17): new entries are built from fragment sections, existing entries get sections
 * appended (user_edited too), `covered_by` sections only gain the source item.
 */
export function integrateFragments(ctx: IntegrationContext, items: OrganizeItem[], result: Aligned, record: ResultRecord): IntegrationResult {
  return withTransaction(ctx.db, () => {
    const db = ctx.db;
    const anchor = items[0]!;
    const buffer = new SourceBuffer(items);
    const changes = new Map<string, EntryChange>();
    const nameToId = new Map<string, string>();
    const discarded: string[] = [];
    let edgesCreated = 0;
    const newEntries = new Map(result.new_entries.map((entry) => [entry.key, entry]));

    const setChange = (entryId: string, change: EntryChange["change"]) => {
      const previous = changes.get(entryId);
      if (previous?.change === "created") return;
      if (previous?.change === "supplemented" && change === "duplicate") return;
      changes.set(entryId, { entryId, name: loadEntry(db, entryId)?.name ?? entryId, change });
    };
    const toSection = (fragment: AlignedFragment) => ({ heading: fragment.heading, markdown: fragment.markdown, sourceItemIds: [buffer.itemIdOf(fragment.turn_item_id)] });
    const recordSections = (entryId: string, fragments: AlignedFragment[], ids: Array<string | null>) =>
      fragments.forEach((fragment, index) => buffer.addSection(entryId, buffer.itemIdOf(fragment.turn_item_id), ids[index] ?? null, fragment.heading));

    for (const group of groupByTarget(result.fragments)) {
      const meta = newEntries.get(group.target);
      const name = meta?.name ?? group.fragments[0]!.concept;
      const aliases = meta?.aliases ?? [];
      const kind = resolveKind(meta?.kind ?? null);
      const decision = decideAlignment({
        match: meta ? "new" : group.target,
        name,
        aliases,
        kind: meta ? kind : null,
        existing_entries: listAliveEntries(db).map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases, kind: normalizeKind(entry.kind) })),
        kb_ignore_names: ctx.kbIgnore,
        name_similarities: ctx.nameSimilarities.get(name) ?? []
      });
      if (decision.action === "discard") {
        discarded.push(name);
        continue;
      }

      let entryId: string;
      if (decision.action === "create_new") {
        const { body, ids } = appendSections("", group.fragments.map(toSection));
        entryId = insertEntry(db, { name, aliases, kind, category: meta?.category ?? null, summary: meta?.summary ?? null, body_markdown: body }, ctx.now);
        recordSections(entryId, group.fragments, ids);
        setChange(entryId, "created");
      } else {
        entryId = decision.entry_id;
        const entry = loadEntry(db, entryId)!;
        let body = entry.body;
        const sections = new Map(entrySections(body).map((section) => [section.sectionId, section]));
        const append: AlignedFragment[] = [];
        for (const fragment of group.fragments) {
          const itemId = buffer.itemIdOf(fragment.turn_item_id);
          // A re-organized item (dirty / inbox_all / retry) already wrote its sections: match them instead of appending again.
          const section =
            (decision.via === "match" && fragment.covered_by ? sections.get(fragment.covered_by) : undefined) ??
            [...sections.values()].find(
              (candidate) => candidate.sourceItemIds.includes(itemId) && verbatimRatio(fragment.markdown, candidate.markdown) >= VERBATIM_MIN_RATIO
            );
          if (!section) {
            append.push(fragment);
            continue;
          }
          if (section.marked) body = attachSectionSources(body, section.sectionId, [itemId]) ?? body;
          buffer.addSection(entryId, itemId, section.marked ? section.sectionId : null, section.heading ?? fragment.heading);
        }
        let patchCount = entry.patchCount;
        if (append.length) {
          const appended = appendSections(body, append.map(toSection));
          body = appended.body;
          patchCount += 1;
          recordSections(entryId, append, appended.ids);
        }
        db.prepare("UPDATE kb_entries SET body_markdown = ?, patch_count = ?, aliases = ?, updated_at = ? WHERE id = ?").run(
          body,
          patchCount,
          JSON.stringify(withAlias(entry.aliases, decision.add_alias)),
          append.length || body !== entry.body ? ctx.now : entry.updatedAt,
          entryId
        );
        setChange(entryId, append.length ? "supplemented" : "duplicate");
      }
      for (const alias of [name, ...aliases, ...group.fragments.map((fragment) => fragment.concept)]) nameToId.set(normalizeEntryName(alias), entryId);
    }

    const resolve = (name: string): string | undefined => nameToId.get(normalizeEntryName(name)) ?? findEntryByName(listAliveEntries(db), name)?.id;
    for (const relation of result.relations) {
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
      { ...record, output: { ...record.output, entry_changes: entryChanges, discarded_concepts: discarded } },
      ctx.runId,
      ctx.now,
      entryChanges.map((change) => change.entryId)
    );
    markNotesUsed(db, ctx.usedNoteIds, ctx.now);
    return { status: "ingested" as const, entryChanges, edgesCreated, touchedEntryIds: touched };
  });
}
