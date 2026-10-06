import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SEED_KINDS } from "@study-studio/shared";
import { EditorView } from "codemirror";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { navigateMock } from "@/test/router-mock";
import { KbEntryPage } from "./KbEntryPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));
vi.mock("./KbGraph", () => ({
  KbGraph: ({ graph }: { graph: { nodes: { id: string }[] } }) => <div data-testid="kb-graph">{graph.nodes.map((n) => n.id).join(",")}</div>
}));

beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = rects;
});

function editorView(): EditorView {
  const host = screen.getByTestId("markdown-editor");
  const dom = host.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("CodeMirror view not mounted");
  return view;
}

describe("KbEntryPage 词条详情", () => {
  beforeEach(() => {
    resetMockState();
    useOrganizeStore.setState({ dialog: null, active: null });
    useUiStore.setState({ toasts: [] });
  });

  it("渲染程序生成段落与来源证据", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-cross" />);
    await screen.findByRole("heading", { level: 1, name: "交叉编码器" });
    expect(screen.getByRole("heading", { level: 3, name: "与 双塔模型 的区别" })).toBeInTheDocument();
    expect(screen.getByText(/建议整理结构/)).toBeInTheDocument();
    expect(document.querySelectorAll(".kb-source").length).toBeGreaterThan(0);
    expect(screen.getByText("在图谱中查看")).toBeInTheDocument();
    expect((await screen.findByTestId("kb-graph")).textContent?.split(",").sort()).toEqual(["kb-attn", "kb-bge", "kb-bi", "kb-cross", "kb-rerank"]);

    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    fireEvent.click(within(await screen.findByRole("tree")).getByText("BM25"));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/wiki/$entryId", params: { entryId: "kb-bm25" } });
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("边注：来源卡片与章节备注挂在对应章节旁，标记行不显示，整篇备注在正文下方", async () => {
    await mockApi.createNote({ scope: "entry", targetId: "kb-cross", text: "用法这节要再看", origin: "workbench", anchor: "s_cross002" });
    await mockApi.createNote({ scope: "entry", targetId: "kb-cross", text: "整篇都很重要", origin: "workbench" });
    renderWithQuery(<KbEntryPage entryId="kb-cross" />);
    await screen.findByRole("heading", { level: 1, name: "交叉编码器" });

    expect(document.body.textContent).not.toContain("section:");
    expect(within(document.querySelector<HTMLElement>('[data-section-id="s_cross001"]')!).getByRole("heading", { level: 2, name: "定义" })).toBeInTheDocument();
    const margin = screen.getByRole("complementary", { name: "边注" });
    const define = within(margin.querySelector<HTMLElement>('[data-margin-for="s_cross001"]')!);
    expect(define.getByText("什么是交叉编码器？")).toBeInTheDocument();
    expect(define.getByText("问：什么是交叉编码器？")).toBeInTheDocument();
    const usage = within(margin.querySelector<HTMLElement>('[data-margin-for="s_cross002"]')!);
    expect(usage.getByText("交叉编码器和双塔模型应该怎么选？")).toBeInTheDocument();
    expect(usage.getByText("用法这节要再看")).toBeInTheDocument();
    expect(within(margin).queryByText("整篇都很重要")).toBeNull();
    expect(within(margin).queryByText("其他来源")).toBeNull();
    expect(screen.getByText("整篇都很重要")).toBeInTheDocument();
    expect(screen.queryByText("来源与摘录")).toBeNull();
    expect(screen.queryByText("常用 bge-reranker、ms-marco-MiniLM")).toBeNull();
  });

  it("不属于任何章节的来源列在「其他来源」", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-rerank" />);
    await screen.findByRole("heading", { level: 1, name: "重排" });
    const others = within(screen.getByRole("complementary", { name: "边注" }).querySelector<HTMLElement>(".kb-margin-others")!);
    expect(others.getByText("其他来源")).toBeInTheDocument();
    expect(others.getByText("交叉编码器和双塔模型应该怎么选？")).toBeInTheDocument();
  });

  it("在边注添加章节备注，请求带 anchor", async () => {
    const spy = vi.spyOn(mockApi, "createNote");
    renderWithQuery(<KbEntryPage entryId="kb-cross" />);
    await screen.findByRole("heading", { level: 1, name: "交叉编码器" });
    const usage = within(screen.getByRole("complementary", { name: "边注" }).querySelector<HTMLElement>('[data-margin-for="s_cross002"]')!);
    fireEvent.click(usage.getByRole("button", { name: "+ 添加备注" }));
    fireEvent.change(usage.getByLabelText("新备注"), { target: { value: "记得对比 ColBERT" } });
    fireEvent.click(usage.getByRole("button", { name: "添加备注" }));

    expect(await usage.findByText("记得对比 ColBERT", { selector: ".note > div" })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: "entry", targetId: "kb-cross", anchor: "s_cross002" }));
    expect((await mockApi.getKbEntry("kb-cross")).notes.find((note) => note.text === "记得对比 ColBERT")?.anchor).toBe("s_cross002");
    spy.mockRestore();
  });

  it("点击来源的对比按钮，全屏弹窗左右展示整理内容与原文", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-cross" />);
    await screen.findByRole("heading", { level: 1, name: "交叉编码器" });
    const entry = await mockApi.getKbEntry("kb-cross");
    const source = entry.sources.find((candidate) => candidate.itemId === "item-p2")!;
    const original = await mockApi.getInboxItem(source.itemId);

    const usage = document.querySelector<HTMLElement>('[data-margin-for="s_cross002"]')!;
    fireEvent.click(within(usage).getByRole("button", { name: "对比原文" }));
    const dialog = await screen.findByRole("dialog", { name: "对比：交叉编码器" });
    const left = within(dialog).getByRole("region", { name: "知识库整理内容" });
    const right = within(dialog).getByRole("region", { name: "来源原文" });
    expect(within(left).getByRole("heading", { level: 3, name: "正文" })).toBeInTheDocument();
    expect(within(right).getByText(source.title)).toBeInTheDocument();
    const snippet = (original.markdown ?? "")
      .split("\n")
      .find((line) => /^[\p{L}\p{N}]/u.test(line.trim()))
      ?.trim();
    if (snippet) expect(await within(right).findByText(snippet, { exact: false })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭对比" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("编辑正文并保存，标记为手动编辑、待整理", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-hybrid" />);
    await screen.findByRole("heading", { level: 1, name: "混合检索" });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const view = editorView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "## 新正文\n\n关键词与向量各取所长。" } });
    expect(await screen.findByText("编辑中 · 未保存")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByTestId("markdown-editor")).toBeNull());
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain("已保存");

    const saved = await mockApi.getKbEntry("kb-hybrid");
    expect(saved.bodyMarkdown).toBe("## 新正文\n\n关键词与向量各取所长。");
    expect(saved.userEdited).toBe(true);
    expect(saved.dirty).toBe(true);
    expect(await screen.findByText("关键词与向量各取所长。")).toBeInTheDocument();
  });

  it("编辑态改类型：只能从内置类型中选择，保存后头部标签更新且不标记手动编辑", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-hybrid" />);
    await screen.findByRole("heading", { level: 1, name: "混合检索" });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    const select = screen.getByLabelText<HTMLSelectElement>("类型");
    expect(select).toHaveValue("方法");
    expect([...select.options].map((option) => option.value)).toEqual([...SEED_KINDS]);

    fireEvent.change(select, { target: { value: "技巧" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByLabelText("类型")).toBeNull());
    expect(screen.getByText("技巧")).toHaveClass("tag");

    const saved = await mockApi.getKbEntry("kb-hybrid");
    expect(saved.kind).toBe("技巧");
    expect(saved.userEdited).toBe(false);
  });

  it("取消编辑不保存", async () => {
    renderWithQuery(<KbEntryPage entryId="kb-hybrid" />);
    await screen.findByRole("heading", { level: 1, name: "混合检索" });
    const before = (await mockApi.getKbEntry("kb-hybrid")).bodyMarkdown;
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const view = editorView();
    view.dispatch({ changes: { from: 0, insert: "草稿 " } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect((await mockApi.getKbEntry("kb-hybrid")).bodyMarkdown).toBe(before);
  });
});
