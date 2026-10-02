import { create } from "zustand";

type Toast = { id: string; message: string; actionLabel?: string; onAction?: () => void };

type UiStore = {
  toasts: Toast[];
  pushToast: (toast: Omit<Toast, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
};

export const useUiStore = create<UiStore>((set, get) => ({
  toasts: [],
  pushToast: (toast) => {
    const id = toast.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set({ toasts: [...get().toasts, { ...toast, id }] });
    window.setTimeout(() => get().dismissToast(id), 4500);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
}));
