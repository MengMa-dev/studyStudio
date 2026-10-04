import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { useKbUiStore } from "@/stores/kb";
import { renderWithQuery } from "@/test/render";
import { KbPage } from "./KbPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));
vi.mock("./KbGraph", () => ({ KbGraph: () => null }));

async function kindOptions(): Promise<string[]> {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="类型筛选"]')!;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(2));
  return [...select.options].map((option) => option.textContent ?? "");
}

const count = async (name: string) => (await mockApi.getKbKinds()).kinds.find((kind) => kind.name === name)?.entryCount;

describe("类型筛选与 KbKindsDialog", () => {
  beforeEach(() => {
    resetMockState();
    useKbUiStore.setState({ checked: new Set() });
  });

  it("下拉选项来自 getKbKinds，显示词条数、不含 0 词条类型；「管理类型…」只打开弹窗", async () => {
    const onFilterChange = vi.fn();
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={onFilterChange} />);
    expect(await kindOptions()).toEqual(["全部类型", "概念（5）", "方法（2）", "算法（4）", "模型（4）", "论文（2）", "管理类型…"]);

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "算法" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ q: "", kind: "算法" });

    onFilterChange.mockClear();
    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "__manage_kinds__" } });
    expect(await screen.findByRole("dialog", { name: "管理类型" })).toBeInTheDocument();
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("改名后列表与当前筛选同步更新", async () => {
    const onFilterChange = vi.fn();
    renderWithQuery(<KbPage q="" kind="论文" selectedId="kb-react" onFilterChange={onFilterChange} />);
    await kindOptions();
    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "__manage_kinds__" } });
    const dialog = await screen.findByRole("dialog", { name: "管理类型" });

    fireEvent.click(within(dialog).getByRole("button", { name: "改名 论文" }));
    fireEvent.change(within(dialog).getByLabelText("新名称：论文"), { target: { value: "文献" } });
    fireEvent.keyDown(within(dialog).getByLabelText("新名称：论文"), { key: "Enter" });

    await within(dialog).findByText("文献");
    expect(within(dialog).queryByText("论文")).toBeNull();
    expect(onFilterChange).toHaveBeenCalledWith({ q: "", kind: "文献" });
    await waitFor(async () => expect(await kindOptions()).toContain("文献（2）"));
  });

  it("输入已有类型名提示合并，确认后原类型消失、目标计数相加", async () => {
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={vi.fn()} />);
    await kindOptions();
    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "__manage_kinds__" } });
    const dialog = await screen.findByRole("dialog", { name: "管理类型" });

    fireEvent.click(within(dialog).getByRole("button", { name: "改名 模型" }));
    const input = within(dialog).getByLabelText("新名称：模型");
    fireEvent.change(input, { target: { value: "概念" } });
    expect(within(dialog).getByText("将合并到『概念』，共 9 个词条")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(await count("模型")).toBe(4);

    fireEvent.click(within(dialog).getByRole("button", { name: "确认合并" }));
    await waitFor(() => expect(within(dialog).queryByText("模型")).toBeNull());
    expect(within(dialog).getByText("9 个词条")).toBeInTheDocument();
    expect(await count("概念")).toBe(9);
  });
});
