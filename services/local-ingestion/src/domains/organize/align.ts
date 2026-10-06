import { ALIGN_PARAMS } from "./constants.js";
import { normalizeEntryName } from "./normalize.js";
import type { AlignmentDecision, AlignmentInput, ExistingEntryRef } from "./types.js";

function findByNormalizedName(name: string, aliases: string[], entries: ExistingEntryRef[]): ExistingEntryRef | undefined {
  const keys = new Set([normalizeEntryName(name), ...aliases.map(normalizeEntryName)]);
  for (const entry of entries) {
    if (entry.deleted) continue;
    const entryKeys = [normalizeEntryName(entry.name), ...entry.aliases.map(normalizeEntryName)];
    if (entryKeys.some((k) => keys.has(k))) return entry;
  }
  return undefined;
}

/**
 * ⑥ Alignment decision (pure).
 * Embedding similarity is an injected number — this module never calls a model.
 */
export function decideAlignment(input: AlignmentInput): AlignmentDecision {
  const ignore = new Set(input.kb_ignore_names.map(normalizeEntryName));
  if (ignore.has(normalizeEntryName(input.name))) {
    return { action: "discard", reason: "kb_ignore" };
  }
  for (const alias of input.aliases ?? []) {
    if (ignore.has(normalizeEntryName(alias))) {
      return { action: "discard", reason: "kb_ignore" };
    }
  }

  const alive = input.existing_entries.filter((e) => !e.deleted);
  const threshold = input.name_embedding_threshold ?? ALIGN_PARAMS.nameEmbeddingThreshold;

  if (input.match !== "new") {
    const found = alive.find((e) => e.id === input.match);
    if (found) {
      return { action: "use_existing", entry_id: found.id, via: "match" };
    }
    // Missing / deleted match → fall through as "new"
  }

  const byName = findByNormalizedName(input.name, input.aliases ?? [], alive);
  if (byName) {
    return {
      action: "use_existing",
      entry_id: byName.id,
      via: "normalized_name",
      add_alias: normalizeEntryName(byName.name) === normalizeEntryName(input.name) ? undefined : input.name,
      demote_body_to_supplement: Boolean(input.body_markdown)
    };
  }

  const sims = (input.name_similarities ?? [])
    .filter((s) => s.similarity > threshold)
    .filter((s) => {
      const entry = alive.find((e) => e.id === s.entry_id);
      if (!entry) return false;
      if (input.kind == null || input.kind === "") return true;
      const kind = s.kind ?? entry?.kind;
      return kind == null || kind === "" || kind === input.kind;
    })
    .sort((a, b) => b.similarity - a.similarity);

  const best = sims[0];
  if (best) {
    return {
      action: "use_existing",
      entry_id: best.entry_id,
      via: "embedding",
      add_alias: input.name,
      demote_body_to_supplement: Boolean(input.body_markdown)
    };
  }

  return {
    action: "create_new",
    name: input.name,
    aliases: input.aliases ?? []
  };
}

/** When alignment rematches a "new" concept onto an existing entry, demote body to add_section「补充」. */
export function demoteNewBodyToSupplement(bodyMarkdown: string): {
  op: "add_section";
  after: string;
  heading: string;
  markdown: string;
} {
  return {
    op: "add_section",
    after: "",
    heading: "## 补充",
    markdown: bodyMarkdown.trim()
  };
}
