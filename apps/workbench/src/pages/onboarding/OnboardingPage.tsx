import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const status = useQuery({ queryKey: ["onboarding"], queryFn: () => api.getOnboarding() });
  const complete = useMutation({
    mutationFn: () => api.completeOnboarding(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      void navigate({ to: "/home" });
      pushToast({ message: "引导完成，开始使用工作台" });
    }
  });

  if (!status.data) return <div className="empty">加载中…</div>;

  return (
    <div className="chat-home" style={{ maxWidth: 640 }}>
      <div className="chat-hero">
        <div className="brand-logo" style={{ width: 44, height: 44, fontSize: 20, borderRadius: 12 }}>
          S
        </div>
        <h1>欢迎使用 Study Studio</h1>
        <div className="muted">完成配对后，浏览器扩展会把学习内容同步到本机知识库</div>
      </div>
      <div className="card stack" style={{ gap: 14, textAlign: "left" }}>
        <div>
          <div className="set-label">1. 复制配对令牌</div>
          <div className="code" style={{ marginTop: 8 }}>
            {status.data.pairingToken ?? "—"}
          </div>
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={async () => {
              if (status.data?.pairingToken) {
                await navigator.clipboard.writeText(status.data.pairingToken);
                pushToast({ message: "已复制" });
              }
            }}
          >
            复制令牌
          </button>
        </div>
        <div>
          <div className="set-label">2. 安装浏览器扩展</div>
          <div className="set-desc">在 Chrome 打开 chrome://extensions，启用开发者模式，加载解压后的扩展目录，并粘贴配对令牌。</div>
        </div>
        <div>
          <div className="set-label">3. 确认连接</div>
          <div className="set-desc">当前扩展状态：{status.data.extensionConnected ? "已连接" : "等待连接（mock 环境可直接继续）"}</div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn primary" onClick={() => complete.mutate()}>
            进入工作台
          </button>
        </div>
      </div>
    </div>
  );
}
