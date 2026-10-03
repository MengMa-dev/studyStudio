import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { ChatContext, ChatPage } from "@study-studio/shared";
import { useKbUiStore } from "@/stores/kb";
import { useSelectionStore } from "@/stores/selection";

/** Chat is available on these routes only; settings / onboarding return null. */
export function chatRouteOf(pathname: string): { page: ChatPage; entryId?: string; itemId?: string } | null {
  const [first, second] = pathname.split("/").filter(Boolean);
  const id = second ? decodeURIComponent(second) : undefined;
  switch (first) {
    case "home":
      return { page: "home" };
    case "wiki":
      return id ? { page: "entry", entryId: id } : { page: "wiki" };
    case "progress":
      return { page: "progress" };
    case "inbox":
      return { page: "inbox" };
    case "item":
      return id ? { page: "item", itemId: id } : null;
    case "runs":
      return { page: "runs" };
    default:
      return null;
  }
}

/** Derives the request context from the route and the inbox / knowledge-base selections. */
export function useChatContext(): ChatContext | null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const route = chatRouteOf(pathname);
  const inboxSelected = useSelectionStore((state) => state.selected);
  const kbChecked = useKbUiStore((state) => state.checked);
  // Inbox selection mixes item and note ids; the inbox page caches the known item ids under this key.
  const inboxItemIds = useQuery<string[]>({ queryKey: ["inbox-all-ids"], enabled: false }).data;

  const page = route?.page;
  const entryId = route?.entryId;
  const itemId = route?.itemId;
  return useMemo(() => {
    if (!page) return null;
    const context: ChatContext = { page };
    if (entryId) context.entryId = entryId;
    if (itemId) context.itemId = itemId;
    if (page === "inbox" && inboxSelected.size) {
      const known = inboxItemIds ? new Set(inboxItemIds) : null;
      const ids = [...inboxSelected].filter((id) => !known || known.has(id));
      if (ids.length) context.selectedItemIds = ids.slice(0, 500);
    }
    if (page === "wiki" && kbChecked.size) context.selectedEntryIds = [...kbChecked].slice(0, 500);
    return context;
  }, [page, entryId, itemId, inboxSelected, kbChecked, inboxItemIds]);
}

export function chatExamples(context: ChatContext | null): string[] {
  switch (context?.page) {
    case "item":
      return ["这篇文章讲了什么", "帮我整理该页知识点"];
    case "entry":
      return ["这个知识点讲解是否完整", "它和哪些知识点有关", "帮我整理该页知识点"];
    case "inbox":
      return context.selectedItemIds?.length ? ["帮我整理已选内容", "我今天学了什么"] : ["整理", "我今天学了什么"];
    case "wiki":
      return context.selectedEntryIds?.length ? ["帮我整理已选内容", "我哪些知识掌握得不好"] : ["我哪些知识掌握得不好", "整理"];
    case "progress":
      return ["我今天学了什么", "最近一周学了哪些"];
    case "runs":
      return ["整理", "我今天学了什么"];
    default:
      return ["我今天学了什么", "最近一周学了哪些", "RAG 到底是什么", "我哪些知识掌握得不好"];
  }
}
