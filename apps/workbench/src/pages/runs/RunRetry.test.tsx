import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, resetMockState } from "@/api";
import { setMockOrganizeTickMs, waitForMockOrganizeIdle } from "@/api/mock/organize";
import { useOrganizeStore } from "@/stores/organize";
import { useUiStore } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { RunDetailPage } from "./RunDetailPage";
import { RunsPage } from "./RunsPage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

describe("整理记录：重试失败项", () => {
  beforeEach(() => {
    resetMockState();
    setMockOrganizeTickMs(0);
    useOrganizeStore.setState({ dialog: null, active: null });
    useUiStore.setState({ toasts: [] });
  });

  afterEach(async () => {
    await waitForMockOrganizeIdle();
  });

  it("记录列表只在有失败项的卡片上提供重试", async () => {
    renderWithQuery(<RunsPage />);
    await waitFor(() => expect(screen.getAllByTestId("run-card").length).toBeGreaterThanOrEqual(4));
    const retryButtons = screen.getAllByRole("button", { name: "重试失败项" });
    expect(retryButtons).toHaveLength(1);
    const card = retryButtons[0]!.closest<HTMLElement>("[data-testid=run-card]")!;
    expect(within(card).getByText(/失败 1/)).toBeInTheDocument();
  });

  it("详情页重试失败项：发起 retry 运行并清空原失败列表", async () => {
    const { client } = renderWithQuery(<RunDetailPage runId="run-1" />);
    const button = await screen.findByRole("button", { name: "重试失败项（1）" });
    expect(screen.getAllByText("context_length_exceeded").length).toBeGreaterThan(0);

    fireEvent.click(button);
    await waitFor(() => expect(useOrganizeStore.getState().active).not.toBeNull());
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe("已重新排队失败项，进度见侧栏");

    const retryRunId = useOrganizeStore.getState().active!.runId;
    await waitForMockOrganizeIdle();
    const retried = await mockApi.getOrganizeRun(retryRunId);
    expect(retried.trigger).toBe("retry");
    expect(retried.status).toBe("completed");
    expect((await mockApi.getOrganizeRun("run-1")).failures).toHaveLength(0);
    await client.invalidateQueries({ queryKey: ["organize-run"] });
    await waitFor(() => expect(screen.queryByRole("button", { name: /重试失败项/ })).toBeNull());
  });
});
