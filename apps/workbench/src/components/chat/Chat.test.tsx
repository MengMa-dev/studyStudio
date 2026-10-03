import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { clearMockAiTask } from "@/api/mock/ai";
import { getMockChatMessages, setMockChatDelay, setMockChatOverLimit } from "@/api/mock/chat";
import { setMockOrganizeTickMs, waitForMockOrganizeIdle } from "@/api/mock/organize";
import { HomePage } from "@/pages/home/HomePage";
import { resetChatSessionForTests } from "@/stores/chat";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { useSelectionStore } from "@/stores/selection";
import { useUiStore } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { setMockPathname } from "@/test/router-mock";
import { ChatDock } from "./ChatDock";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

function input(scope: HTMLElement | Document = document): HTMLTextAreaElement {
  return within(scope as HTMLElement).getByLabelText("对话输入") as HTMLTextAreaElement;
}

function ask(text: string, scope?: HTMLElement) {
  const box = input(scope);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

function openDock(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
  return screen.getByRole("complementary", { name: "悬浮对话" });
}

async function waitIdle(scope: HTMLElement) {
  await waitFor(() => expect(within(scope).getByRole("button", { name: "发送" })).toBeInTheDocument(), { timeout: 5000 });
}

describe("首页对话与悬浮对话", () => {
  beforeEach(async () => {
    resetMockState();
    await resetChatSessionForTests();
    setMockChatDelay(0);
    setMockOrganizeTickMs(0);
    setMockPathname("/home");
    useOrganizeStore.setState({ dialog: null, active: null });
    useUiStore.setState({ toasts: [] });
    useSelectionStore.setState({ selected: new Set() });
    useKbUiStore.setState({ checked: new Set() });
  });

  afterEach(async () => {
    resetMockState();
    await waitForMockOrganizeIdle();
  });

  it("首页空状态：问候、输入框、档案按钮、示例问题与入口卡片", async () => {
    renderWithQuery(<HomePage />);
    expect(await screen.findByRole("heading", { name: /今天已经学习了/ })).toBeInTheDocument();
    expect(input()).toBeEnabled();
    expect(screen.getByRole("button", { name: "学习者档案" })).toBeInTheDocument();
    const examples = screen.getByLabelText("示例问题");
    expect(within(examples).getByRole("button", { name: "我今天学了什么" })).toBeInTheDocument();
    expect(within(examples).getByRole("button", { name: "我哪些知识掌握得不好" })).toBeInTheDocument();
    for (const label of ["今日学习", "知识库", "薄弱知识点"]) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("发送后流式渲染回答，[n] 上标与依据跳转到对应对象", async () => {
    setMockChatDelay(2);
    const { container } = renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    ask("RAG 到底是什么");

    expect(await screen.findByText("RAG 到底是什么", { selector: ".bubble" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "停止" })).toBeInTheDocument();
    await waitIdle(container);

    expect(screen.getByText(/RAG（检索增强生成）/)).toBeInTheDocument();
    const basis = screen.getByLabelText("依据");
    const hybrid = within(basis).getByRole("link", { name: /混合检索/ });
    expect(hybrid).toHaveAttribute("href", "#/wiki/kb-hybrid");
    const sups = container.querySelectorAll(".chat-cite a");
    expect(sups).toHaveLength(3);
    expect(sups[0]?.getAttribute("href")).toBe(within(basis).getAllByRole("link")[0]?.getAttribute("href"));
    expect(screen.getByRole("button", { name: "清空对话" })).toBeInTheDocument();
  });

  it("时间回顾的依据含学习日与条目，非学习记录回答带标记", async () => {
    const { container } = renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    fireEvent.click(screen.getByRole("button", { name: "我今天学了什么" }));
    await screen.findByText(/今天你学习了/);
    const basis = await screen.findByLabelText("依据");
    expect(within(basis).getByRole("link", { name: /学习日/ })).toHaveAttribute("href", "#/progress");
    expect(within(basis).getByRole("link", { name: /从零实现 HNSW/ })).toHaveAttribute("href", "#/item/item-p1");

    await waitIdle(container);
    ask("什么是 k8s");
    expect(await screen.findByText("非学习记录")).toBeInTheDocument();
    expect(await screen.findByText(/知识库没有相关内容/)).toBeInTheDocument();
  });

  it("悬浮按钮按路由显隐", async () => {
    renderWithQuery(<ChatDock />);
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();
    for (const pathname of ["/wiki", "/wiki/kb-cross", "/progress", "/inbox", "/item/item-p1", "/runs"]) {
      act(() => setMockPathname(pathname));
      expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
    }
    for (const pathname of ["/home", "/settings/ai", "/onboarding"]) {
      act(() => setMockPathname(pathname));
      expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();
    }
  });

  it("点击面板外收起；生成中收起不中断，重新展开可见完整回答", async () => {
    setMockPathname("/wiki");
    setMockChatDelay(2);
    renderWithQuery(<ChatDock />);
    let panel = openDock();
    expect(within(panel).getByText("当前：知识库")).toBeInTheDocument();

    fireEvent.pointerDown(within(panel).getByText(/基于当前页面/));
    expect(screen.getByRole("complementary", { name: "悬浮对话" })).toBeInTheDocument();

    ask("我哪些知识掌握得不好", panel);
    await within(panel).findByRole("button", { name: "停止" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("complementary", { name: "悬浮对话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();

    await waitFor(() => expect(getMockChatMessages().filter((message) => message.role === "assistant")).toHaveLength(1), { timeout: 5000 });
    panel = openDock();
    expect(within(panel).getByText(/比较薄弱的/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("首页与悬浮面板共享消息，切换路由不丢失", async () => {
    const { container } = renderWithQuery(
      <>
        <HomePage />
        <ChatDock />
      </>
    );
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    ask("RAG 到底是什么");
    await screen.findByText(/RAG（检索增强生成）/);
    await waitIdle(container.querySelector(".chat-page") as HTMLElement);

    act(() => setMockPathname("/wiki/kb-cross"));
    const panel = openDock();
    expect(within(panel).getByText("RAG 到底是什么")).toBeInTheDocument();

    ask("这个知识点讲解是否完整", panel);
    await within(panel).findByText(/还缺少/);
    const homeList = container.querySelector(".chat-list") as HTMLElement;
    expect(within(homeList).getByText("这个知识点讲解是否完整")).toBeInTheDocument();
    expect(within(homeList).getByText("在「词条详情」提问")).toBeInTheDocument();

    act(() => setMockPathname("/progress"));
    expect(within(screen.getByRole("complementary", { name: "悬浮对话" })).getByText("RAG 到底是什么")).toBeInTheDocument();
  });

  it("刷新后从服务端回放历史；清空后回到空状态", async () => {
    const first = renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    ask("我最近在学 AI 相关知识");
    await screen.findByText(/已记录/);
    await waitIdle(first.container);
    first.unmount();

    await resetChatSessionForTests();
    renderWithQuery(<HomePage />);
    expect(await screen.findByText("我最近在学 AI 相关知识")).toBeInTheDocument();
    expect(screen.getByLabelText("学习者档案记录")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空对话" }));
    expect(await screen.findByRole("heading", { name: /今天已经学习了/ })).toBeInTheDocument();
    expect(getMockChatMessages()).toHaveLength(0);
  });

  it("单选项整理卡片：预填当前条目与要求，确认调用 runOrganize", async () => {
    setMockPathname("/item/item-p1");
    const runOrganize = vi.spyOn(mockApi, "runOrganize");
    renderWithQuery(<ChatDock />);
    const panel = openDock();
    fireEvent.click(within(panel).getByRole("button", { name: "帮我整理该页知识点" }));

    const card = await within(panel).findByLabelText("整理确认");
    expect(within(card).getByText("当前条目")).toBeInTheDocument();
    expect(within(card).getByText("从零实现 HNSW：分层可导航小世界图")).toBeInTheDocument();
    const requirement = within(card).getByLabelText(/整理要求/);
    expect((requirement as HTMLTextAreaElement).value).not.toBe("");
    fireEvent.change(requirement, { target: { value: "重点看参数" } });
    fireEvent.click(within(card).getByRole("button", { name: "确认整理" }));

    await within(panel).findByText("✦ 已开始整理");
    expect(runOrganize).toHaveBeenCalledWith({ scope: "item", itemIds: ["item-p1"], entryIds: [], requirement: "重点看参数" });
    expect(useOrganizeStore.getState().active).not.toBeNull();
    runOrganize.mockRestore();
  });

  it("多选项整理卡片：词条详情给出三个选项，先选范围再确认；「调整」打开整理弹窗", async () => {
    setMockPathname("/wiki/kb-cross");
    const runOrganize = vi.spyOn(mockApi, "runOrganize");
    renderWithQuery(<ChatDock />);
    const panel = openDock();
    ask("整理", panel);

    const card = await within(panel).findByLabelText("整理确认");
    const radios = within(card).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(within(card).getByText("当前知识点")).toBeInTheDocument();
    const confirm = within(card).getByRole("button", { name: "确认整理" });
    expect(confirm).toBeDisabled();

    fireEvent.click(within(card).getByRole("radio", { name: /当前知识点/ }));
    fireEvent.click(within(card).getByRole("button", { name: "调整" }));
    expect(useOrganizeStore.getState().dialog).toMatchObject({
      scopes: ["entry", "inbox_pending", "inbox_all"],
      defaultScope: "entry",
      entryIds: ["kb-cross"],
      targetName: "交叉编码器"
    });

    fireEvent.click(within(card).getByRole("radio", { name: /全量/ }));
    fireEvent.click(confirm);
    await within(panel).findByText("✦ 已开始整理");
    expect(runOrganize).toHaveBeenCalledWith(expect.objectContaining({ scope: "inbox_all" }));
    runOrganize.mockRestore();
  });

  it("收集箱有已选时整理卡片出现「已选」；已有整理进行时提示", async () => {
    setMockPathname("/inbox");
    useSelectionStore.setState({ selected: new Set(["item-p1", "item-p2"]) });
    setMockOrganizeTickMs(60_000);
    await mockApi.runOrganize({ scope: "inbox_pending" });
    renderWithQuery(<ChatDock />);
    const panel = openDock();
    ask("整理", panel);

    const card = await within(panel).findByLabelText("整理确认");
    fireEvent.click(within(card).getByRole("radio", { name: /已选（2 条）/ }));
    fireEvent.click(within(card).getByRole("button", { name: "确认整理" }));
    expect(await within(card).findByText("已有整理在进行，完成后再试")).toBeInTheDocument();
  });

  it("档案卡片：记录学习方向，撤销后恢复旧值", async () => {
    renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    ask("我最近在学 AI 相关知识");

    const card = await screen.findByLabelText("学习者档案记录");
    expect(within(card).getByText("AI")).toBeInTheDocument();
    expect((await mockApi.getLearnerProfile()).profile.directions.map((direction) => direction.text)).toContain("AI");

    fireEvent.click(within(card).getByRole("button", { name: "撤销" }));
    expect(await within(card).findByText("已撤销记录")).toBeInTheDocument();
    const restored = (await mockApi.getLearnerProfile()).profile;
    expect(restored.directions.map((direction) => direction.text)).toEqual(["Agent 架构"]);
    expect(restored.role).toBe("前端开发");
  });

  it("未配置对话模型时禁用输入并链接到 AI 设置", async () => {
    clearMockAiTask("knowledge_processing");
    renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    await waitFor(() => expect(input()).toBeDisabled());
    expect(screen.getByRole("link", { name: "去 AI 设置配置" })).toHaveAttribute("href", "#/settings/ai");
    expect(within(screen.getByLabelText("示例问题")).getByRole("button", { name: "我今天学了什么" })).toBeDisabled();
  });

  it("超出每日上限时显示确认条，确认后带 allowOverLimit 重发", async () => {
    setMockChatOverLimit(true);
    renderWithQuery(<HomePage />);
    await screen.findByRole("heading", { name: /今天已经学习了/ });
    ask("我哪些知识掌握得不好");

    expect(await screen.findByText(/今日 token 已达上限/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仍然继续" }));
    expect(await screen.findByText(/比较薄弱的/)).toBeInTheDocument();
    expect(screen.queryByText(/今日 token 已达上限/)).not.toBeInTheDocument();
    expect(screen.getAllByText("我哪些知识掌握得不好", { selector: ".bubble" })).toHaveLength(1);
  });
});
