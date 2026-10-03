import type { ChatContext, ChatOrganizeOption } from "@study-studio/shared";

export const ORGANIZE_TARGETS = ["current", "pending", "all", "selected", "ask"] as const;
export type OrganizeTarget = (typeof ORGANIZE_TARGETS)[number];

/** Resolve display names of the current object; `null` when it no longer exists. */
export type OrganizeLookups = {
  entryName: (id: string) => string | null;
  itemTitle: (id: string) => string | null;
};

type PageKind = "entry" | "item" | "inbox" | "kb" | "other";

function pageKind(context: ChatContext): PageKind {
  if (context.page === "entry") return context.entryId ? "entry" : "kb";
  if (context.page === "item") return context.itemId ? "item" : "other";
  if (context.page === "inbox") return "inbox";
  if (context.page === "wiki") return "kb";
  return "other";
}

const uniq = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).filter(Boolean))];

function option(partial: Pick<ChatOrganizeOption, "scope" | "label"> & Partial<ChatOrganizeOption>): ChatOrganizeOption {
  return { itemIds: [], entryIds: [], ...partial };
}

function currentOption(context: ChatContext, kind: PageKind, lookups: OrganizeLookups): ChatOrganizeOption | null {
  if (kind === "entry" && context.entryId) {
    const name = lookups.entryName(context.entryId);
    return name === null ? null : option({ scope: "entry", label: "当前知识点", entryIds: [context.entryId], targetName: name });
  }
  if (kind === "item" && context.itemId) {
    const title = lookups.itemTitle(context.itemId);
    return title === null ? null : option({ scope: "item", label: "当前条目", itemIds: [context.itemId], targetName: title });
  }
  return null;
}

function selectedOption(context: ChatContext, kind: PageKind): ChatOrganizeOption | null {
  if (kind === "inbox") {
    const itemIds = uniq(context.selectedItemIds);
    return itemIds.length > 0 ? option({ scope: "inbox_selected", label: `已选（${itemIds.length} 条）`, itemIds }) : null;
  }
  if (kind === "kb") {
    const entryIds = uniq(context.selectedEntryIds);
    return entryIds.length > 0 ? option({ scope: "kb_selected", label: `已选（${entryIds.length} 个知识点）`, entryIds }) : null;
  }
  return null;
}

const isKb = (kind: PageKind) => kind === "kb" || kind === "entry";

function pendingOption(kind: PageKind): ChatOrganizeOption {
  if (kind === "entry") return option({ scope: "kb_pending", label: "所有未整理内容" });
  return isKb(kind) ? option({ scope: "kb_pending", label: "待整理" }) : option({ scope: "inbox_pending", label: "待整理" });
}

function allOption(kind: PageKind): ChatOrganizeOption {
  return isKb(kind) ? option({ scope: "kb_all", label: "全量" }) : option({ scope: "inbox_all", label: "全量" });
}

/** Options listed when the user did not name a scope (09「整理意图」). */
function askOptions(context: ChatContext, kind: PageKind, lookups: OrganizeLookups): ChatOrganizeOption[] {
  if (kind === "entry") {
    const current = currentOption(context, kind, lookups);
    return [...(current ? [current] : []), pendingOption(kind), allOption(kind)];
  }
  if (kind === "inbox" || kind === "kb") {
    const selected = selectedOption(context, kind);
    return [pendingOption(kind), allOption(kind), ...(selected ? [selected] : [])];
  }
  return [pendingOption("other"), allOption("other")];
}

/**
 * Map the model's `target` plus page context to organize card options (09「Tools」).
 * `current` / `selected` without a usable object fall back to `ask`. Every option satisfies
 * `organizeRunRequestSchema` (item / entry carry exactly one id, *_selected at least one).
 */
export function resolveOrganizeOptions(context: ChatContext, target: OrganizeTarget, lookups: OrganizeLookups): ChatOrganizeOption[] {
  const kind = pageKind(context);
  if (target === "current") {
    const current = currentOption(context, kind, lookups);
    if (current) return [current];
  } else if (target === "selected") {
    const selected = selectedOption(context, kind);
    if (selected) return [selected];
  } else if (target === "pending") {
    return [pendingOption(kind)];
  } else if (target === "all") {
    return [allOption(kind)];
  }
  return askOptions(context, kind, lookups);
}
