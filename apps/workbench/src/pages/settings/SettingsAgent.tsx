import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_SKILL_TARGETS, type AgentConfigResponse, type AgentSkillTarget } from "@study-studio/shared";
import { api } from "@/api";
import { useUiStore } from "@/stores/ui";
import { setGroup, setRow } from "./SettingsPage";

const CONFIG_KEY = ["agent-config"];

/** Client config formats follow each client's current docs; update here when they change. */
const CLIENT_SNIPPETS: { id: AgentSkillTarget; label: string; desc: string; snippet: (config: AgentConfigResponse) => string }[] = [
  {
    id: "cursor",
    label: "Cursor",
    desc: "写入 ~/.cursor/mcp.json",
    snippet: ({ url, token }) => JSON.stringify({ mcpServers: { "study-studio": { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  },
  {
    id: "claude",
    label: "Claude Code",
    desc: "在终端执行",
    snippet: ({ url, token }) => `claude mcp add --transport http study-studio ${url} --header "Authorization: Bearer ${token}"`
  },
  {
    id: "codex",
    label: "Codex",
    desc: "写入 ~/.codex/config.toml，并在启动 Codex 的 shell 中 export STUDY_STUDIO_MCP_TOKEN",
    snippet: ({ url, token }) =>
      `[mcp_servers.study-studio]\nurl = "${url}"\nbearer_token_env_var = "STUDY_STUDIO_MCP_TOKEN"\n\n# shell：\n# export STUDY_STUDIO_MCP_TOKEN=${token}`
  }
];

const SKILL_DIR: Record<AgentSkillTarget, string> = { cursor: "~/.cursor/skills", claude: "~/.claude/skills", codex: "~/.codex/skills" };

export function SettingsAgent() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const config = useQuery({ queryKey: CONFIG_KEY, queryFn: () => api.getAgentConfig() });
  const [targets, setTargets] = useState<AgentSkillTarget[]>([...AGENT_SKILL_TARGETS]);

  const resetToken = useMutation({
    mutationFn: () => api.resetAgentToken(),
    onSuccess: (next) => {
      queryClient.setQueryData(CONFIG_KEY, next);
      pushToast({ message: "MCP 令牌已重置，请更新各客户端配置" });
    }
  });
  const install = useMutation({
    mutationFn: () => api.installAgentSkill({ targets }),
    onSuccess: (result) => pushToast({ message: `已安装到 ${result.paths.length} 个位置` }),
    onError: (error) => pushToast({ message: `安装失败：${error instanceof Error ? error.message : String(error)}` })
  });

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    pushToast({ message: `已复制${label}` });
  };

  if (!config.data) return <div className="empty">加载中…</div>;
  const data = config.data;

  return (
    <>
      {setGroup(
        "MCP 服务",
        <>
          {setRow(
            "地址",
            <span className="mono">{data.url}</span>,
            <button type="button" className="btn sm" onClick={() => void copy(data.url, "地址")}>
              复制
            </button>
          )}
          {setRow(
            "令牌",
            <span className="mono">{`${data.token.slice(0, 6)}••••••••${data.token.slice(-4)}`}</span>,
            <>
              <button type="button" className="btn sm" onClick={() => void copy(data.token, "令牌")}>
                复制
              </button>
              <button type="button" className="btn sm danger" disabled={resetToken.isPending} onClick={() => resetToken.mutate()}>
                重置
              </button>
            </>
          )}
        </>,
        undefined,
        "仅本机可访问；重置后旧令牌立即失效"
      )}
      {setGroup(
        "客户端配置",
        CLIENT_SNIPPETS.map(({ id, label, desc, snippet }) => {
          const text = snippet(data);
          return (
            <div key={id}>
              {setRow(
                label,
                <>
                  {desc}
                  <pre className="code" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                    {text}
                  </pre>
                </>,
                <button type="button" className="btn sm" onClick={() => void copy(text, `${label} 配置`)}>
                  复制
                </button>
              )}
            </div>
          );
        })
      )}
      {setGroup(
        "整理 Skill",
        setRow(
          "organize-kb",
          <span className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {AGENT_SKILL_TARGETS.map((target) => (
              <label key={target} className="row small">
                <input
                  type="checkbox"
                  checked={targets.includes(target)}
                  onChange={(event) => setTargets((prev) => (event.target.checked ? [...prev, target] : prev.filter((item) => item !== target)))}
                />
                {SKILL_DIR[target]}
              </label>
            ))}
          </span>,
          <button type="button" className="btn sm primary" disabled={targets.length === 0 || install.isPending} onClick={() => install.mutate()}>
            {install.isPending ? "安装中…" : "安装"}
          </button>
        ),
        undefined,
        `写入 <目录>/organize-kb/SKILL.md（版本 ${data.skillVersion}）；之后在 agent 中说「整理收件箱」即可`
      )}
    </>
  );
}
