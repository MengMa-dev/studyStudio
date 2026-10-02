import type { DatabaseSync } from "node:sqlite";
import type { ExclusionRule } from "@study-studio/shared";
import type { RuleRow } from "../../db/types.js";

export function listRules(db: DatabaseSync): ExclusionRule[] {
  return (db.prepare("SELECT id, kind, value, note, created_at FROM rules ORDER BY created_at").all() as RuleRow[]).map((row) => ({
    id: row.id,
    kind: row.kind as ExclusionRule["kind"],
    value: row.value,
    note: row.note,
    createdAt: row.created_at
  }));
}

export function insertRule(db: DatabaseSync, rule: ExclusionRule): void {
  db.prepare("INSERT INTO rules(id, kind, value, note, created_at) VALUES (?, ?, ?, ?, ?)").run(rule.id, rule.kind, rule.value, rule.note, rule.createdAt);
}

export function deleteRule(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Returns true when the URL matches any exclusion rule (exact url, domain, prefix, or list-page glob). */
export function matchesExclusionRule(url: string | undefined | null, rules: ExclusionRule[]): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const href = parsed.href;
  const path = parsed.pathname;

  for (const rule of rules) {
    const value = rule.value.trim();
    if (!value) continue;
    switch (rule.kind) {
      case "url":
        if (href === value || href.replace(/\/$/, "") === value.replace(/\/$/, "")) return true;
        break;
      case "domain": {
        const domain = value.replace(/^www\./, "").toLowerCase();
        if (host === domain || host.endsWith(`.${domain}`)) return true;
        break;
      }
      case "url_prefix":
        if (href.startsWith(value)) return true;
        break;
      case "list_page": {
        // Simple path glob: `*` matches any path segment characters except `/` when not `**`.
        const pattern = value.includes("://") ? value : `${parsed.protocol}//${parsed.host}${value.startsWith("/") ? value : `/${value}`}`;
        if (globMatch(href, pattern) || globMatch(path, value)) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

function globMatch(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(input);
}

export function eventUrlForRules(event: { source?: { url?: string; canonicalUrl?: string }; content?: { canonicalUrl?: string } }): string | undefined {
  return event.content?.canonicalUrl ?? event.source?.canonicalUrl ?? event.source?.url;
}

export { hostOf };
