import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockState } from "@/api";
import { useOrganizeStore } from "@/stores/organize";
import { renderWithQuery } from "@/test/render";
import { RunDetailPage } from "./RunDetailPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

describe("整理详情：流水线", () => {
  beforeEach(() => {
    resetMockState();
    useOrganizeStore.setState({ dialog: null, active: null });
  });

  it("点击节点展示该阶段记录与输入输出 JSON", async () => {
    renderWithQuery(<RunDetailPage runId="run-1" />);
    expect(await screen.findByText("上下文")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /片段切分/ }));
    expect(screen.getByText("片段 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /知识处理/ }));
    expect(screen.getByText("知识抽取 · LLM")).toBeInTheDocument();
    expect(screen.getAllByText(/双塔模型可离线预计算文档向量/).length).toBe(2);
    expect(screen.getAllByText("输入 JSON").length).toBe(3);

    expect(screen.getByRole("button", { name: /词条重写/ })).toBeDisabled();
  });
});
