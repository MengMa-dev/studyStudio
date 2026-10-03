import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { setMockOrganizeTickMs, waitForMockOrganizeIdle } from "@/api/mock/organize";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { OrganizeDialogHost, REQUIREMENT_CHIPS } from "./OrganizeDialog";

describe("OrganizeDialog 整理弹窗", () => {
  beforeEach(() => {
    resetMockState();
    setMockOrganizeTickMs(0);
    useOrganizeStore.setState({ dialog: null, active: null });
    useUiStore.setState({ toasts: [] });
  });

  afterEach(async () => {
    await waitForMockOrganizeIdle();
  });

  it("切换范围显示信号统计，填写要求后发起整理", async () => {
    renderWithQuery(<OrganizeDialogHost />);
    act(() => useOrganizeStore.getState().openDialog({ scopes: ["inbox_pending", "inbox_all"] }));

    await waitFor(() => expect(screen.getByTestId("organize-signals")).toHaveTextContent(/本次会整理 \d+ 条内容/));
    const pendingText = screen.getByTestId("organize-signals").textContent;
    fireEvent.click(screen.getByRole("radio", { name: /全量/ }));
    await waitFor(() => expect(screen.getByTestId("organize-signals").textContent).not.toBe(pendingText));

    fireEvent.change(screen.getByLabelText(/整理要求/), { target: { value: "重点讲原理" } });
    fireEvent.click(screen.getByRole("button", { name: REQUIREMENT_CHIPS[0] }));
    expect(screen.getByLabelText(/整理要求/)).toHaveValue(`重点讲原理；${REQUIREMENT_CHIPS[0]}`);

    const start = screen.getByRole("button", { name: "开始整理" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(useOrganizeStore.getState().dialog).toBeNull());
    const active = useOrganizeStore.getState().active;
    expect(active?.runId).toBeTruthy();
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe("已开始整理，进度见侧栏");

    const detail = await mockApi.getOrganizeRun(active!.runId);
    expect(detail.scope).toBe("inbox_all");
    expect(detail.requirement).toBe(`重点讲原理；${REQUIREMENT_CHIPS[0]}`);
  });

  it("已有整理进行中时禁止再次发起", async () => {
    useOrganizeStore.setState({ active: { runId: "run-x", done: 1, total: 3, stage: "integration", currentTitle: null } });
    renderWithQuery(<OrganizeDialogHost />);
    act(() => useOrganizeStore.getState().openDialog({ scopes: ["entry"], entryIds: ["kb-cross"], targetName: "交叉编码器" }));
    await waitFor(() => expect(screen.getByTestId("organize-signals")).toHaveTextContent("本次会重写 1 个知识点"));
    expect(screen.getByRole("button", { name: "开始整理" })).toBeDisabled();
    expect(screen.getByText(/正在整理（1\/3）/)).toBeInTheDocument();
  });
});
