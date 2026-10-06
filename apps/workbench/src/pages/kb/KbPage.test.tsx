import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "@/api";
import { useKbUiStore } from "@/stores/kb";
import { useOrganizeStore } from "@/stores/organize";
import { renderWithQuery } from "@/test/render";
import { navigateMock } from "@/test/router-mock";
import { KbPage } from "./KbPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

const graph = vi.hoisted(() => ({ props: null as null | ComponentProps<typeof import("./KbGraph").KbGraph> }));
vi.mock("./KbGraph", () => ({
  KbGraph: (props: NonNullable<typeof graph.props>) => {
    graph.props = props;
    return <div data-testid="kb-graph" />;
  }
}));

async function graphProps() {
  await waitFor(() => expect(graph.props).not.toBeNull());
  return graph.props!;
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
  if (!row) throw new Error(`row ${id} not rendered`);
  return row;
}

beforeEach(() => {
  resetMockState();
  navigateMock.mockReset();
  useKbUiStore.setState({ checked: new Set(), collapsed: new Set(), graphRelation: "all" });
  useOrganizeStore.setState({ dialog: null, active: null });
  graph.props = null;
});

describe("KbPage 知识库目录", () => {
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

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "工具/资源" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ q: "hnsw", kind: "工具/资源" });

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
    await waitFor(() => expect(screen.getByLabelText("选择 HNSW")).toBeChecked());
    fireEvent.click(document.querySelector('[data-organize-scope="kb_selected"]')!);
    expect(useOrganizeStore.getState().dialog).toMatchObject({ scopes: ["kb_selected", "kb_pending", "kb_all"], entryIds: ["kb-bm25", "kb-hnsw"] });
  });
});

describe("KbPage 图谱联动", () => {
  it("图谱只跟勾选联动：悬停不影响，全部取消恢复默认态", async () => {
    renderWithQuery(<KbPage q="" kind={undefined} selectedId="kb-cross" onFilterChange={vi.fn()} />);
    await screen.findByLabelText("选择 BM25");
    expect((await graphProps()).checked).toEqual([]);

    fireEvent.mouseEnter(rowOf("kb-bm25"));
    fireEvent.mouseEnter(document.querySelector<HTMLElement>("[data-category-key]")!);
    expect(graph.props!.checked).toEqual([]);

    fireEvent.click(screen.getByLabelText("选择 BM25"));
    fireEvent.click(screen.getByLabelText("选择 HNSW"));
    expect(graph.props!.checked).toEqual(["kb-bm25", "kb-hnsw"]);
    fireEvent.click(screen.getByLabelText("选择 BM25"));
    fireEvent.click(screen.getByLabelText("选择 HNSW"));
    expect(graph.props!.checked).toEqual([]);
  });

  it("图谱单击切换目录勾选并展开定位，双击进入详情", async () => {
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    await screen.findByLabelText("选择 BM25");
    const category = rowOf("kb-cross").closest('[role="group"]')!.querySelector<HTMLElement>(".tree-cat")!;
    fireEvent.click(category);
    expect(document.querySelector('[data-entry-id="kb-cross"]')).toBeNull();

    act(() => graph.props!.onToggle("kb-cross"));
    expect(screen.getByLabelText("选择 交叉编码器")).toBeChecked();
    expect(graph.props!.checked).toEqual(["kb-cross"]);
    expect(rowOf("kb-cross")).toBeInTheDocument();

    act(() => graph.props!.onToggle("kb-cross"));
    expect(screen.getByLabelText("选择 交叉编码器")).not.toBeChecked();
    expect(graph.props!.checked).toEqual([]);

    act(() => graph.props!.onOpen("kb-cross"));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/wiki/$entryId", params: { entryId: "kb-cross" } });
  });

  it("关系 chips 切换后切换模块仍保留", async () => {
    const view = renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    expect((await graphProps()).relation).toBe("all");
    fireEvent.click(screen.getByRole("button", { name: "前置" }));
    expect(graph.props!.relation).toBe("prerequisite");

    view.unmount();
    graph.props = null;
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    expect((await graphProps()).relation).toBe("prerequisite");
    expect(screen.getByRole("button", { name: "前置" })).toHaveAttribute("aria-pressed", "true");
  });
});
