import { create } from "zustand";

/** Knowledge-base page UI state kept across module switches (08 / 11 模块状态保留). */
type KbUiStore = {
  checked: Set<string>;
  collapsed: Set<string>;
  /** Entry or `cat:<id>` last hovered in the tree; drives the preview panel. */
  previewKey: string | null;
  toggleChecked: (id: string) => void;
  setChecked: (ids: string[], checked: boolean) => void;
  clearChecked: () => void;
  toggleCollapsed: (categoryKey: string) => void;
  expand: (categoryKey: string) => void;
  setPreview: (key: string | null) => void;
};

export const useKbUiStore = create<KbUiStore>((set, get) => ({
  checked: new Set(),
  collapsed: new Set(),
  previewKey: null,
  toggleChecked: (id) => {
    const next = new Set(get().checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ checked: next });
  },
  setChecked: (ids, checked) => {
    const next = new Set(get().checked);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    set({ checked: next });
  },
  clearChecked: () => set({ checked: new Set() }),
  toggleCollapsed: (categoryKey) => {
    const next = new Set(get().collapsed);
    if (next.has(categoryKey)) next.delete(categoryKey);
    else next.add(categoryKey);
    set({ collapsed: next });
  },
  expand: (categoryKey) => {
    if (!get().collapsed.has(categoryKey)) return;
    const next = new Set(get().collapsed);
    next.delete(categoryKey);
    set({ collapsed: next });
  },
  setPreview: (key) => set({ previewKey: key })
}));
