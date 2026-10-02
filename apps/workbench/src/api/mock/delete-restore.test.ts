import { beforeEach, describe, expect, it } from "vitest";
import { mockApi, resetMockState, getMockState } from "@/api";

describe("删除 → 撤销恢复", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("删除条目后可通过回收站恢复", async () => {
    const before = await mockApi.getInboxList({ type: "all", status: "all", limit: 50 });
    const target = before.rows.find((row) => row.kind === "item" && row.id === "item-p1");
    expect(target).toBeTruthy();

    const deleted = await mockApi.deleteItems({
      ids: ["item-p1"],
      noteIds: ["note-fuzzy-1"],
      removeFromKb: true,
      rule: "none"
    });
    expect(deleted.deletedItemCount).toBe(1);
    expect(deleted.deletedNoteCount).toBe(1);

    const afterDelete = await mockApi.getInboxList({ type: "all", status: "all", limit: 50 });
    expect(afterDelete.rows.some((row) => row.id === "item-p1")).toBe(false);
    expect(afterDelete.rows.some((row) => row.id === "note-fuzzy-1")).toBe(false);

    const trash = await mockApi.listTrash();
    expect(trash.entries.some((entry) => entry.id === deleted.trashId)).toBe(true);

    const restored = await mockApi.restoreTrash(deleted.trashId);
    expect(restored.restoredItemCount).toBe(1);
    expect(restored.restoredNoteCount).toBe(1);

    const afterRestore = await mockApi.getInboxList({ type: "all", status: "all", limit: 50 });
    expect(afterRestore.rows.some((row) => row.id === "item-p1")).toBe(true);
    expect(afterRestore.rows.some((row) => row.id === "note-fuzzy-1")).toBe(true);
    expect(getMockState().items.find((item) => item.id === "item-p1")?.deletedAt).toBeNull();
  });
});
