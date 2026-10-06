import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetMockState } from "@/api";
import { useUiStore } from "@/stores/ui";
import { AgentInstallGroup } from "./SettingsAgent";

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentInstallGroup />
    </QueryClientProvider>
  );
}

describe("模型能力 · 一键安装到 Agent", () => {
  beforeEach(() => {
    resetMockState();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it("每个 Agent 一键安装，安装后显示已安装；不展示 MCP 地址与令牌", async () => {
    renderSection();
    const buttons = await screen.findAllByRole("button", { name: "一键安装" });
    expect(buttons).toHaveLength(3);
    expect(document.body.textContent).not.toContain("mcp-mock-token");
    fireEvent.click(buttons[2]!);
    await waitFor(() => expect(useUiStore.getState().toasts.at(-1)?.message).toBe("已安装到 Codex，重新加载 Codex 后生效"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "一键安装" })).toHaveLength(2));
    expect(screen.getByRole("button", { name: "重新安装" })).toBeInTheDocument();
  });
});
