import { categorizeDomain, domainOf, parseSearch, type CollectorSettings, type ExclusionRule } from "@study-studio/shared";

export function matchesExclusion(url: string, rules: ExclusionRule[], builtinListPageRules: string[] = []): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  for (const rule of rules) {
    const value = rule.value.trim();
    if (rule.kind === "url" && (url === value || parsed.href === value)) return true;
    if (rule.kind === "domain") {
      const domain = value.replace(/^www\./, "");
      if (host === domain || host.endsWith(`.${domain}`)) return true;
    }
    if (rule.kind === "url_prefix" && url.startsWith(value)) return true;
    if (rule.kind === "list_page") {
      try {
        if (new RegExp(value, "i").test(url)) return true;
      } catch {
        if (url.includes(value)) return true;
      }
    }
  }
  for (const pattern of builtinListPageRules) {
    try {
      if (new RegExp(pattern, "i").test(url)) return true;
    } catch {
      // ignore bad builtin patterns
    }
  }
  return false;
}

export function resolveCategory(url: string, settings: CollectorSettings) {
  return categorizeDomain(domainOf(url), settings.activityTracking.unrelatedDomains);
}

export function detectSearch(url: string) {
  return parseSearch(url);
}

const AI_HOSTS = ["chatgpt.com", "chat.openai.com", "chat.deepseek.com"];

export function isAiConversationUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return AI_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

export type TabNavState = {
  tabId: number;
  openerTabId?: number;
  transition?: "link" | "typed" | "back_forward" | "reload" | "other";
  referrer?: string;
  fromSearch?: boolean;
  url?: string;
};

const TRANSITION_MAP: Record<string, TabNavState["transition"]> = {
  link: "link",
  typed: "typed",
  auto_bookmark: "typed",
  auto_toplevel: "typed",
  generated: "typed",
  start_page: "typed",
  form_submit: "link",
  reload: "reload",
  keyword: "typed",
  keyword_generated: "typed"
};

export function mapTransition(transitionType?: string): TabNavState["transition"] {
  if (!transitionType) return "other";
  if (transitionType === "forward_back") return "back_forward";
  return TRANSITION_MAP[transitionType] ?? "other";
}
