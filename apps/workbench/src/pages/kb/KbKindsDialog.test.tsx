import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "@/api";
import { useKbUiStore } from "@/stores/kb";
import { renderWithQuery } from "@/test/render";
import { KbPage } from "./KbPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));
vi.mock("./KbGraph", () => ({ KbGraph: () => null }));

describe("类型筛选", () => {
  beforeEach(() => {
    resetMockState();
    useKbUiStore.setState({ checked: new Set() });
  });

  it("始终列出全部内置类型（含 0 词条），不提供管理类型", async () => {
    const onFilterChange = vi.fn();
    renderWithQuery(<KbPage q="" kind={undefined} selectedId={undefined} onFilterChange={onFilterChange} />);
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="类型筛选"]')!;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(2));
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "全部类型",
      "概念（5）",
      "原理（4）",
      "事实（0）",
      "方法（6）",
      "技巧（0）",
      "规范（0）",
      "工具/资源（2）",
      "案例（0）",
      "复盘（0）",
      "其他（0）"
    ]);

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "方法" } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ q: "", kind: "方法" });
  });
});
