import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockApi, resetMockState } from "@/api";
import { useUiStore } from "@/stores/ui";
import { SettingsAi } from "./SettingsAi";

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsAi />
    </QueryClientProvider>
  );
}

function providerRow(name: string): HTMLElement {
  const label = screen.getAllByText(name).find((element) => element.classList.contains("set-label"));
  const row = label?.closest<HTMLElement>(".provider-row");
  if (!row) throw new Error(`provider row ${name} not found`);
  return row;
}

describe("设置 · AI 模型", () => {
  beforeEach(() => {
    resetMockState();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it("展示用量、服务商和四个任务（不含首页对话）", async () => {
    renderSection();
    expect(await screen.findByText("模型服务商")).toBeInTheDocument();
    expect(screen.getByLabelText("今日用量")).toHaveTextContent("17.6k");
    expect(providerRow("Gemini")).toHaveTextContent("已连接 · 用于 2 项任务");
    for (const label of ["学习判定", "知识处理", "词条重写", "向量 Embedding"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/首页对话\s*$/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("AIzaSyMockKey1234");
  });

  it("展开服务商：Key 只显示掩码，测试连接后显示结果", async () => {
    renderSection();
    await screen.findByText("模型服务商");
    fireEvent.click(providerRow("Gemini"));
    const form = screen.getByLabelText("Gemini 配置");
    expect(within(form).getByPlaceholderText("AIz…1234")).toHaveValue("");
    fireEvent.click(within(form).getByRole("button", { name: "测试连接" }));
    expect(await within(form).findByRole("status")).toHaveTextContent("连接成功");
  });

  it("添加服务商后自动展开，可删除未被使用的服务商", async () => {
    renderSection();
    await screen.findByText("模型服务商");
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加服务商" }));
    const form = screen.getByLabelText("新服务商");
    fireEvent.change(within(form).getByPlaceholderText("例如：DeepSeek"), { target: { value: "本地 Mock" } });
    fireEvent.change(within(form).getByLabelText("类型"), { target: { value: "mock" } });
    fireEvent.click(within(form).getByRole("button", { name: "添加" }));

    const created = await screen.findByLabelText("本地 Mock 配置");
    expect((await mockApi.listAiProviders()).providers.some((provider) => provider.name === "本地 Mock")).toBe(true);
    fireEvent.click(within(created).getByRole("button", { name: "删除" }));
    fireEvent.click(within(created).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByLabelText("本地 Mock 配置")).not.toBeInTheDocument());
    expect((await mockApi.listAiProviders()).providers.some((provider) => provider.name === "本地 Mock")).toBe(false);
  });

  it("删除仍被任务使用的服务商时提示", async () => {
    renderSection();
    await screen.findByText("模型服务商");
    fireEvent.click(providerRow("Ollama"));
    const form = screen.getByLabelText("Ollama 配置");
    fireEvent.click(within(form).getByRole("button", { name: "删除" }));
    fireEvent.click(within(form).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(
        useUiStore
          .getState()
          .toasts.map((toast) => toast.message)
          .join()
      ).toContain("学习判定")
    );
    expect(screen.getByLabelText("Ollama 配置")).toBeInTheDocument();
  });

  it("按任务改选模型并保存，设置每日上限", async () => {
    renderSection();
    await screen.findByText("模型服务商");
    const row = document.querySelector<HTMLElement>('[data-task="entry_rewrite"]')!;
    fireEvent.change(within(row).getByLabelText("备用服务商"), { target: { value: "ollama" } });
    expect(within(row).getByLabelText("备用模型")).toHaveValue("qwen2.5:7b");
    fireEvent.click(within(row).getByRole("button", { name: "保存" }));
    await waitFor(async () => {
      const task = (await mockApi.getAiTasks()).tasks.find((candidate) => candidate.task === "entry_rewrite");
      expect(task?.fallbackProviderId).toBe("ollama");
      expect(task?.fallbackModel).toBe("qwen2.5:7b");
    });

    fireEvent.change(screen.getByLabelText("每日上限（tokens）"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存上限" }));
    await waitFor(async () => expect((await mockApi.getAiUsage()).dailyTokenLimit).toBe(50_000));
    expect(await screen.findByText(/\/ 50\.0k tokens/)).toBeInTheDocument();
  });
});
