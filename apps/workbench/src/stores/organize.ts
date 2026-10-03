import { create } from "zustand";
import type { OrganizeScope, OrganizeStage } from "@study-studio/shared";

export type OrganizeDialogRequest = {
  /** Range options offered in the dialog; the first one is preselected unless `defaultScope` is set. */
  scopes: OrganizeScope[];
  defaultScope?: OrganizeScope;
  itemIds?: string[];
  entryIds?: string[];
  /** Title for single-target scopes (`item` / `entry`). */
  targetName?: string;
  prefill?: string;
};

export type ActiveRun = {
  runId: string;
  done: number;
  total: number;
  stage: OrganizeStage | null;
  currentTitle: string | null;
};

type OrganizeStore = {
  dialog: OrganizeDialogRequest | null;
  active: ActiveRun | null;
  openDialog: (request: OrganizeDialogRequest) => void;
  closeDialog: () => void;
  setActive: (active: ActiveRun | null) => void;
  patchActive: (runId: string, patch: Partial<ActiveRun>) => void;
};

export const useOrganizeStore = create<OrganizeStore>((set, get) => ({
  dialog: null,
  active: null,
  openDialog: (request) => set({ dialog: request }),
  closeDialog: () => set({ dialog: null }),
  setActive: (active) => set({ active }),
  patchActive: (runId, patch) => {
    const current = get().active;
    set({ active: { ...(current?.runId === runId ? current : { runId, done: 0, total: 0, stage: null, currentTitle: null }), ...patch } });
  }
}));
