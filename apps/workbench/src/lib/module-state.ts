export type ModuleId = "home" | "wiki" | "progress" | "inbox" | "runs" | "settings" | "onboarding";

export const MODULE_OF: Record<string, ModuleId> = {
  home: "home",
  wiki: "wiki",
  progress: "progress",
  inbox: "inbox",
  item: "inbox",
  trash: "inbox",
  runs: "runs",
  settings: "settings",
  onboarding: "onboarding"
};

export const DEFAULT_MODULE_ROUTES: Record<ModuleId, string> = {
  home: "/home",
  wiki: "/wiki",
  progress: "/progress",
  inbox: "/inbox",
  runs: "/runs",
  settings: "/settings/collect",
  onboarding: "/onboarding"
};

export function moduleOfPath(pathname: string): ModuleId {
  const segment = pathname.replace(/^\//, "").split("/")[0] ?? "home";
  return MODULE_OF[segment] ?? "home";
}

export function rememberRoute(memory: Record<ModuleId, string>, pathname: string, search: string): Record<ModuleId, string> {
  const module = moduleOfPath(pathname);
  return { ...memory, [module]: `${pathname}${search}` };
}

export function routeForModule(memory: Record<ModuleId, string>, module: ModuleId): string {
  return memory[module] ?? DEFAULT_MODULE_ROUTES[module];
}
