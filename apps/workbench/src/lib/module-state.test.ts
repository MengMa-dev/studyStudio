import { describe, expect, it } from "vitest";
import { DEFAULT_MODULE_ROUTES, moduleOfPath, rememberRoute, routeForModule } from "@/lib/module-state";

describe("模块状态保留", () => {
  it("记住各模块最后路由（含 search）并在侧栏跳转时恢复", () => {
    let memory = { ...DEFAULT_MODULE_ROUTES };
    memory = rememberRoute(memory, "/inbox", "?type=webpage&status=unread");
    memory = rememberRoute(memory, "/settings/data", "");
    memory = rememberRoute(memory, "/item/item-p2", "");

    expect(moduleOfPath("/item/item-p2")).toBe("inbox");
    expect(routeForModule(memory, "inbox")).toBe("/item/item-p2");
    expect(routeForModule(memory, "settings")).toBe("/settings/data");

    memory = rememberRoute(memory, "/inbox", "?type=conversation&status=pending");
    expect(routeForModule(memory, "inbox")).toBe("/inbox?type=conversation&status=pending");
  });
});
