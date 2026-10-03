import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "@/api";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { renderWithQuery } from "@/test/render";
import { navigateMock } from "@/test/router-mock";
import { KbPage } from "./KbPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
  if (!row) throw new Error(`row ${id} not rendered`);
  return row;
}

describe("KbPage 知识库目录", () => {
  beforeEach(() => {
    resetMockState();
    navigateMock.mockReset();
    useKbUiStore.setState({ checked: new Set(), collapsed: new Set(), previewKey: null });
    useOrganizeStore.setState({ dialog: null, active: null });
  });

  it("按分类与 part_of 嵌套渲染目录，并显示状态标记", async () => {
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    await screen.findByLabelText("选择 BM25");
    const categories = [...document.querySelectorAll<HTMLElement>(".tree-cat")];
    expect(categories.map((row) => row.textContent)).toEqual([
      expect.stringContaining("检索"),
      expect.stringContaining("Agent 框架"),
      expect.stringContaining("大模型基础"),
      expect.stringContaining("未归类")
    ]);

    const cross = rowOf("kb-cross");
    const rerank = rowOf("kb-rerank");
    expect(Number(cross.dataset.depth)).toBeGreaterThan(Number(rerank.dataset.depth));
    expect(within(rowOf("kb-hnsw")).getByText("无来源")).toBeInTheDocument();

    fireEvent.click(categories[0]!);
    expect(document.querySelector('[data-entry-id="kb-cross"]')).toBeNull();

    fireEvent.click(rowOf("kb-langgraph"));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/wiki/$entryId", params: { entryId: "kb-langgraph" } });
  });

  it("搜索与类型筛选切换为平铺结果", async () => {
    const onFilterChange = vi.fn();
    const view = renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={onFilterChange} />);
    await screen.findByLabelText("选择 BM25");

    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("搜索词条"), { target: { value: "hnsw" } });
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();
    expect(onFilterChange).toHaveBeenCalledWith({ q: "hnsw", kind: undefined });

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "paper" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ q: "hnsw", kind: "paper" });

    view.rerender(<KbPage q="hnsw" kind={undefined} selectedId={undefined} onFilterChange={onFilterChange} />);
    await screen.findByText("找到 1 个词条");
    expect(document.querySelectorAll("[data-entry-id]")).toHaveLength(1);
    expect(rowOf("kb-hnsw")).toBeInTheDocument();
  });

  it("勾选后整理只针对选中的知识点", async () => {
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    await screen.findByLabelText("选择 BM25");
    fireEvent.click(screen.getByLabelText("选择 BM25"));
    fireEvent.click(screen.getByLabelText("选择 HNSW"));
    await waitFor(() => expect(screen.getAllByText("✦ 整理 2").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("✦ 整理 2")[0]!);
    expect(useOrganizeStore.getState().dialog).toMatchObject({ scopes: ["kb_selected", "kb_pending", "kb_all"], entryIds: ["kb-bm25", "kb-hnsw"] });
  });
});
