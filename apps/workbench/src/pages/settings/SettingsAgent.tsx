import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentInstallResult, AgentSkillTarget } from "@study-studio/shared";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";
import { setGroup, setRow } from "./SettingsPage";

const CONFIG_KEY = ["agent-config"];
const PROVIDERS_KEY = ["ai-providers"];

const CLIENTS: { id: AgentSkillTarget; label: string; writes: string }[] = [
  { id: "cursor", label: "Cursor", writes: "~/.cursor/skills/organize-kb、~/.cursor/mcp.json" },
  { id: "claude", label: "Claude Code", writes: "~/.claude/skills/organize-kb、claude mcp add（需已安装 claude CLI）" },
  { id: "codex", label: "Codex", writes: "~/.codex/skills/organize-kb、~/.codex/config.toml" }
];

/** 「模型能力」里的一键安装卡：每个 Agent 写入 organize-kb skill 并注册当前服务的 MCP。 */
export function AgentInstallGroup() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const config = useQuery({ queryKey: CONFIG_KEY, queryFn: () => api.getAgentConfig() });
  const [failed, setFailed] = useState<Partial<Record<AgentSkillTarget, AgentInstallResult>>>({});

  const install = useMutation({
    mutationFn: (target: AgentSkillTarget) => api.installAgent({ target }),
    onSuccess: (result) => {
      setFailed((prev) => ({ ...prev, [result.target]: result.ok ? undefined : result }));
      const label = CLIENTS.find((client) => client.id === result.target)?.label;
      pushToast({ message: result.ok ? `已安装到 ${label}，重新加载 ${label} 后生效` : `${label} 的 MCP 需手动完成` });
      void queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (error) => pushToast({ message: `安装失败：${error instanceof Error ? error.message : String(error)}` })
  });
  const test = useMutation({
    mutationFn: (target: AgentSkillTarget) => api.testAiProvider(`agent-${target}`, {}),
    onSuccess: (result) => {
      pushToast({ message: result.ok ? `Agent 可用 · ${result.latencyMs} ms` : `Agent 不可用：${result.error ?? "未知错误"}` });
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (error) => pushToast({ message: `测试失败：${error instanceof Error ? error.message : String(error)}` })
  });

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    pushToast({ message: "已复制命令" });
  };

  if (!config.data) return null;
  const data = config.data;

  return setGroup(
    "一键安装到 Agent",
    CLIENTS.map(({ id, label, writes }) => {
      const installed = data.installed[id];
      const manual = failed[id]?.manual;
      const pending = install.isPending && install.variables === id;
      return (
        <div key={id}>
          {setRow(
            <>
              {label} {installed ? <span className="tag green">已安装</span> : <span className="tag">未安装</span>}
            </>,
            <>
              写入 {writes}
              {manual ? (
                <pre className="code" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                  {manual}
                </pre>
              ) : null}
            </>,
            <>
              {manual ? (
                <button type="button" className="btn sm" onClick={() => void copy(manual)}>
                  复制
                </button>
              ) : null}
              {installed ? (
                <button type="button" className="btn sm" disabled={test.isPending} onClick={() => test.mutate(id)}>
                  {test.isPending && test.variables === id ? "测试中…" : "测试"}
                </button>
              ) : null}
              <button type="button" className="btn sm primary" disabled={install.isPending} onClick={() => install.mutate(id)}>
                {pending ? "安装中…" : installed ? "重新安装" : "一键安装"}
              </button>
            </>
          )}
        </div>
      );
    }),
    undefined,
    `安装 organize-kb skill（版本 ${data.skillVersion}）并注册本机 Study Studio 的 MCP；装好后可在 Agent 里说「整理收件箱」，也可在下方「按任务选择模型」中把它当模型用（需本机已登录该 Agent 的命令行，如 agent login）`
  );
}
