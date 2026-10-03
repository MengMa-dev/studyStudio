import { fireEvent, screen, waitFor } from "@testing-library/react";
import { EditorView } from "codemirror";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { KbEntryPage } from "./KbEntryPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

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
    expect(screen.getByText(/建议重新整理/)).toBeInTheDocument();
    expect(document.querySelectorAll(".kb-source").length).toBeGreaterThan(0);
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
