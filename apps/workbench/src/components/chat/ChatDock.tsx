import { useEffect, useRef } from "react";
import type { ChatPage } from "@study-studio/shared";
import { CHAT_PAGE_LABEL } from "@/lib/chat";
import { setChatContext, useChatUiStore } from "@/stores/chat";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageList } from "./ChatMessageList";
import { ChatStatusBar } from "./ChatStatusBar";
import { chatExamples, useChatContext } from "./chat-context";
import { ExampleQuestions } from "./ExampleQuestions";
import { useChatSession } from "./useChatSession";

/** Clicks inside dialogs / toasts opened from the panel (e.g. 「调整」 → organize dialog) must not collapse it. */
const KEEP_OPEN_SELECTOR = ".modal-overlay, .modal-panel, [role='dialog'], .toast";

/** Mounted once in the app layout: keeps the chat context current and shows the floating panel off the home page. */
export function ChatDock() {
  const context = useChatContext();
  const open = useChatUiStore((state) => state.dockOpen);
  const setOpen = useChatUiStore((state) => state.setDockOpen);
  const visible = context !== null && context.page !== "home";

  useEffect(() => {
    setChatContext(context ?? { page: "home" });
  }, [context]);

  if (!visible) return null;
  if (!open) {
    return (
      <button type="button" className="dock-fab" aria-label="打开对话" title="问问" onClick={() => setOpen(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-12.8 7.2L3 20l1.4-4.8A8.4 8.4 0 1 1 21 11.5z" />
        </svg>
      </button>
    );
  }
  return <DockPanel page={context.page} examples={chatExamples(context)} />;
}

function DockPanel({ page, examples }: { page: ChatPage; examples: string[] }) {
  const session = useChatSession();
  const setOpen = useChatUiStore((state) => state.setDockOpen);
  const panelRef = useRef<HTMLElement>(null);
  const onClose = () => setOpen(false);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (panelRef.current?.contains(target) || target.closest(KEEP_OPEN_SELECTOR)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [setOpen]);

  const disabled = !session.configured;
  const empty = session.messages.length === 0;
  const statusBar = <ChatStatusBar {...session} />;

  return (
    <aside className="dock-panel" ref={panelRef} aria-label="悬浮对话">
      <div className="dock-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            ✧ 问问{" "}
            <span className="small faint" style={{ fontWeight: 400 }}>
              与首页对话同步
            </span>
          </div>
          <div className="small muted dock-ctx">当前：{CHAT_PAGE_LABEL[page]}</div>
        </div>
        <button type="button" className="btn sm ghost" disabled={empty && !session.busy} onClick={session.clear}>
          清空
        </button>
        <button type="button" className="btn sm ghost" aria-label="收起" onClick={onClose}>
          ✕
        </button>
      </div>
      {empty ? (
        <div className="dock-list">
          <div className="small muted" style={{ padding: "6px 2px" }}>
            基于当前页面和你的知识库回答，试试：
          </div>
          <ExampleQuestions questions={examples} variant="list" disabled={disabled} onAsk={session.send} />
          {statusBar}
        </div>
      ) : (
        <ChatMessageList className="dock-list" messages={session.messages} status={session.status} currentPage={page} footer={statusBar} />
      )}
      <ChatComposer
        variant="dock"
        busy={session.busy}
        disabled={disabled}
        placeholder={disabled ? "未配置对话模型" : "针对当前页面提问…"}
        onSend={session.send}
        onStop={session.stop}
        autoFocus
      />
    </aside>
  );
}
