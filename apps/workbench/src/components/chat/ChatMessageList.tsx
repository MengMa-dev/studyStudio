import { useEffect, useRef, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import type { ChatPage } from "@study-studio/shared";
import type { StudyChatMessage } from "@/lib/chat";
import { BotBubble, ChatMessage } from "./ChatMessage";

type Props = {
  messages: StudyChatMessage[];
  status: ChatStatus;
  className: string;
  currentPage?: ChatPage;
  /** Rendered after the last message (error / over-limit bars). */
  footer?: ReactNode;
};

export function ChatMessageList({ messages, status, className, currentPage, footer }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  const lastLength = last ? JSON.stringify(last.parts).length : 0;

  useEffect(() => {
    const list = listRef.current;
    if (list && list.scrollHeight > list.clientHeight) list.scrollTop = list.scrollHeight;
    else endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, lastLength, status]);

  return (
    <div className={className} ref={listRef} aria-live="polite">
      {messages.map((message, index) => (
        <ChatMessage
          key={message.id}
          message={message}
          currentPage={currentPage}
          streaming={status === "streaming" && index === messages.length - 1 && message.role === "assistant"}
        />
      ))}
      {status === "submitted" && last?.role === "user" ? <BotBubble muted>正在检索你的学习记录…</BotBubble> : null}
      {footer}
      <div ref={endRef} />
    </div>
  );
}
