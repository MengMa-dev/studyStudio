import type { DatabaseSync } from "node:sqlite";
import { LEGACY_KIND_NAMES, MAX_KIND_LENGTH, MAX_KINDS, OTHER_KIND, SEED_KINDS } from "@study-studio/shared";
import { normalizeKind } from "../kb/queries.js";
import { normalizeEntryName } from "./normalize.js";

/** Map a model-proposed kind onto the vocabulary; new kinds allowed until MAX_KINDS. */
export function resolveKind(raw: string | null | undefined, vocabulary: readonly string[]): string {
  const name = raw?.trim() ?? "";
  if (!name) return OTHER_KIND;
  if (Object.hasOwn(LEGACY_KIND_NAMES, name.toLowerCase())) return LEGACY_KIND_NAMES[name.toLowerCase()]!;
  const hit = vocabulary.find((kind) => normalizeEntryName(kind) === normalizeEntryName(name));
  if (hit) return hit;
  if ([...name].length > MAX_KIND_LENGTH || vocabulary.length >= MAX_KINDS) return OTHER_KIND;
  return name;
}

export function kindVocabulary(db: DatabaseSync): string[] {
  const used = (db.prepare("SELECT DISTINCT kind FROM kb_entries WHERE deleted_at IS NULL AND kind IS NOT NULL").all() as Array<{ kind: string }>).map((row) =>
    normalizeKind(row.kind)
  );
  return [...new Set([...SEED_KINDS, ...used])];
}
