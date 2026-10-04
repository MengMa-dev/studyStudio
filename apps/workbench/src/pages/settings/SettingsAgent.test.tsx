import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetMockState } from "@/api";
import { useUiStore } from "@/stores/ui";
import { SettingsAgent } from "./SettingsAgent";

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsAgent />
    </QueryClientProvider>
  );
}

describe("设置 · Agent 接入", () => {
  beforeEach(() => {
    resetMockState();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it("展示地址与三家客户端配置，令牌重置后片段更新", async () => {
    renderSection();
    expect(await screen.findByText("http://127.0.0.1:43118/mcp")).toBeInTheDocument();
    expect(document.body.textContent).toContain('"Authorization": "Bearer mcp-mock-token-0001"');
    expect(document.body.textContent).toContain("claude mcp add --transport http study-studio http://127.0.0.1:43118/mcp");
    expect(document.body.textContent).toContain('bearer_token_env_var = "STUDY_STUDIO_MCP_TOKEN"');
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    await waitFor(() => expect(document.body.textContent).not.toContain("mcp-mock-token-0001"));
  });

  it("按勾选目标安装 skill", async () => {
    renderSection();
    fireEvent.click(await screen.findByLabelText("~/.codex/skills"));
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => expect(useUiStore.getState().toasts.at(-1)?.message).toBe("已安装到 2 个位置"));
  });
});
