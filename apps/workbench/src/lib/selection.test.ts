import { describe, expect, it } from "vitest";
import { applySelectAllPage, clearSelection, createSelection, pageSelectionStats, partitionSelection, toggleSelection } from "@/lib/selection";

describe("收集箱选择逻辑", () => {
  it("跨页保留已选，全选只作用于当前页", () => {
    let state = createSelection(["item-1", "item-2"]);
    state = applySelectAllPage(state, ["item-3", "item-4"], true);
    expect([...state.selected].sort()).toEqual(["item-1", "item-2", "item-3", "item-4"]);

    state = applySelectAllPage(state, ["item-3", "item-4"], false);
    expect([...state.selected].sort()).toEqual(["item-1", "item-2"]);

    const stats = pageSelectionStats(state.selected, ["item-1", "item-3"]);
    expect(stats.picked).toBe(1);
    expect(stats.hidden).toBe(1);
    expect(stats.partial).toBe(true);
  });

  it("批量分区条目与备注 id", () => {
    const selected = createSelection(["item-1", "note-fuzzy-1", "item-2"]).selected;
    const parts = partitionSelection(selected, ["item-1", "item-2", "item-3"]);
    expect(parts.itemIds.sort()).toEqual(["item-1", "item-2"]);
    expect(parts.noteIds).toEqual(["note-fuzzy-1"]);
  });

  it("切换与清空", () => {
    let state = createSelection();
    state = toggleSelection(state, "a");
    state = toggleSelection(state, "b");
    state = toggleSelection(state, "a");
    expect([...state.selected]).toEqual(["b"]);
    state = clearSelection();
    expect(state.selected.size).toBe(0);
  });
});
