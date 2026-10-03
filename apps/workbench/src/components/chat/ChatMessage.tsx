import type { ReactNode } from "react";
import type { ChatPage } from "@study-studio/shared";
import { CHAT_PAGE_LABEL, citationsOf, isToolPart, messageText, type StudyChatMessage } from "@/lib/chat";
import { ChatMarkdown } from "./ChatMarkdown";
import { CitationList } from "./CitationList";
import { OrganizeConfirmCard } from "./OrganizeConfirmCard";
import { ProfileRecordedCard } from "./ProfileRecordedCard";

type Props = {
  message: StudyChatMessage;
  /** True while this assistant message is still streaming. */
  streaming?: boolean;
  /** User messages asked on another page show where they came from. */
  currentPage?: ChatPage;
};

export function BotBubble({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <div className="msg bot">
      <div className="bot-avatar">S</div>
      <div className={`bot-body ${muted ? "muted" : ""}`}>{children}</div>
    </div>
  );
}

export function ChatMessage({ message, streaming, currentPage }: Props) {
  if (message.role === "user") {
    const askedOn = message.metadata?.context?.page;
    return (
      <div className="msg user">
        {askedOn && currentPage && askedOn !== currentPage ? <div className="msg-ctx">在「{CHAT_PAGE_LABEL[askedOn]}」提问</div> : null}
        <div className="bubble">{messageText(message)}</div>
      </div>
    );
  }

  const citationData = citationsOf(message);
  const citations = citationData?.citations ?? [];
  const markdown = messageText(message);
  const toolPending = streaming && !markdown && message.parts.some(isToolPart);

  return (
    <BotBubble>
      {citationData?.nonRecord ? <span className="tag orange chat-nonrecord">非学习记录</span> : null}
      {markdown ? <ChatMarkdown markdown={markdown} citations={citations} /> : null}
      {toolPending ? <div className="muted small">正在查询学习记录…</div> : null}
      {streaming && !markdown && !toolPending ? <div className="muted small">正在检索你的学习记录…</div> : null}
      {message.parts.map((part, index) => {
        if (part.type === "data-organize-card") return <OrganizeConfirmCard key={part.id ?? `organize-${index}`} data={part.data} />;
        if (part.type === "data-profile-card") return <ProfileRecordedCard key={part.id ?? `profile-${index}`} data={part.data} />;
        return null;
      })}
      <CitationList citations={citations} />
    </BotBubble>
  );
}
