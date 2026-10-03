import { Link } from "@tanstack/react-router";
import type { ChatSession } from "./useChatSession";

type Props = Pick<ChatSession, "error" | "errorCode" | "configured" | "retry" | "continueOverLimit" | "dismissError">;

function SettingsLink() {
  return (
    <Link to="/settings/$section" params={{ section: "ai" }}>
      去 AI 设置配置
    </Link>
  );
}

export function ChatStatusBar({ error, errorCode, configured, retry, continueOverLimit, dismissError }: Props) {
  if (!configured || errorCode === "chat_model_not_configured") {
    return (
      <div className="chat-alert" role="alert">
        <span className="grow">还没有配置对话模型（未单独配置时使用「知识处理」模型），</span>
        <SettingsLink />
        {error ? (
          <button type="button" className="btn sm ghost" onClick={retry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }
  if (!error) return null;
  if (errorCode === "usage_limit_exceeded") {
    return (
      <div className="chat-alert warn" role="alert">
        <span className="grow">今日 token 已达上限，是否仍然继续本次对话？</span>
        <button type="button" className="btn sm primary" onClick={continueOverLimit}>
          仍然继续
        </button>
        <button type="button" className="btn sm ghost" onClick={dismissError}>
          取消
        </button>
      </div>
    );
  }
  return (
    <div className="chat-alert error" role="alert">
      <span className="grow">回答失败：{errorCode === "model_failed" ? "模型调用失败" : error.message || "网络错误"}</span>
      <button type="button" className="btn sm" onClick={retry}>
        重试
      </button>
    </div>
  );
}
