import { LEGACY_KIND_NAMES, OTHER_KIND, SEED_KINDS } from "@study-studio/shared";
import { normalizeEntryName } from "./normalize.js";

/** Map a model-proposed kind onto the seed kinds; anything else becomes OTHER_KIND (custom kinds are disabled for now). */
export function resolveKind(raw: string | null | undefined): string {
  const name = raw?.trim() ?? "";
  if (Object.hasOwn(LEGACY_KIND_NAMES, name.toLowerCase())) return LEGACY_KIND_NAMES[name.toLowerCase()]!;
  return SEED_KINDS.find((kind) => normalizeEntryName(kind) === normalizeEntryName(name)) ?? OTHER_KIND;
}