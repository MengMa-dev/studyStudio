import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  variant: "home" | "dock";
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Slot to the right of the input box (home: learner-profile button). */
  trailing?: ReactNode;
  autoFocus?: boolean;
};

const MAX_HEIGHT = 160;

export function ChatComposer({ variant, busy, disabled, placeholder, onSend, onStop, trailing, autoFocus }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = () => {
    if (disabled || busy || !text.trim()) return;
    onSend(text);
    setText("");
  };

  const button = busy ? (
    <button type="button" className={`btn ${variant === "dock" ? "sm" : ""}`} onClick={onStop}>
      停止
    </button>
  ) : (
    <button type="button" className={`btn primary ${variant === "dock" ? "sm" : ""}`} disabled={disabled || !text.trim()} onClick={submit}>
      发送
    </button>
  );

  const textarea = (
    <textarea
      ref={ref}
      rows={1}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-label="对话输入"
      autoFocus={autoFocus}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }}
    />
  );

  if (variant === "dock") {
    return (
      <div className="dock-input">
        {textarea}
        {button}
      </div>
    );
  }
  return (
    <div className="composer-row">
      <div className={`composer ${disabled ? "chat-composer-disabled" : ""}`}>
        {textarea}
        {button}
      </div>
      {trailing}
    </div>
  );
}
