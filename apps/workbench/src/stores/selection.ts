import { create } from "zustand";
import { applySelectAllPage, clearSelection, toggleSelection, type SelectionId } from "@/lib/selection";

type SelectionStore = {
  selected: Set<SelectionId>;
  toggle: (id: SelectionId) => void;
  selectAllPage: (pageIds: SelectionId[], checked: boolean) => void;
  clear: () => void;
  setMany: (ids: SelectionId[]) => void;
};

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  selected: new Set(),
  toggle: (id) => set({ selected: toggleSelection({ selected: get().selected }, id).selected }),
  selectAllPage: (pageIds, checked) => set({ selected: applySelectAllPage({ selected: get().selected }, pageIds, checked).selected }),
  clear: () => set({ selected: clearSelection().selected }),
  setMany: (ids) => set({ selected: new Set(ids) })
}));
