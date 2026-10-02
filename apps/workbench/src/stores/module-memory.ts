import { create } from "zustand";
import { DEFAULT_MODULE_ROUTES, rememberRoute, routeForModule, type ModuleId } from "@/lib/module-state";

type ModuleMemoryStore = {
  lastRoutes: Record<ModuleId, string>;
  scrollByRoute: Record<string, number>;
  remember: (pathname: string, search: string) => void;
  hrefFor: (module: ModuleId) => string;
  saveScroll: (routeKey: string, scrollTop: number) => void;
  getScroll: (routeKey: string) => number;
};

export const useModuleMemoryStore = create<ModuleMemoryStore>((set, get) => ({
  lastRoutes: { ...DEFAULT_MODULE_ROUTES },
  scrollByRoute: {},
  remember: (pathname, search) => set({ lastRoutes: rememberRoute(get().lastRoutes, pathname, search) }),
  hrefFor: (module) => routeForModule(get().lastRoutes, module),
  saveScroll: (routeKey, scrollTop) => set({ scrollByRoute: { ...get().scrollByRoute, [routeKey]: scrollTop } }),
  getScroll: (routeKey) => get().scrollByRoute[routeKey] ?? 0
}));
