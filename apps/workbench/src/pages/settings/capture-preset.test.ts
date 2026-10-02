import { beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_PRESETS } from "@study-studio/shared";
import { mockApi, resetMockState } from "@/api";

describe("设置预设切换", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("切换正式/调试预设写入对应阈值，手动改阈值变为 custom", async () => {
    const debug = await mockApi.putSettings({ captureRules: { preset: "debug" } });
    expect(debug.captureRules.preset).toBe("debug");
    expect(debug.captureRules.minActiveSeconds).toBe(CAPTURE_PRESETS.debug.minActiveSeconds);
    expect(debug.captureRules.minScrollDepth).toBe(CAPTURE_PRESETS.debug.minScrollDepth);

    const standard = await mockApi.putSettings({ captureRules: { preset: "standard" } });
    expect(standard.captureRules.preset).toBe("standard");
    expect(standard.captureRules.minActiveSeconds).toBe(CAPTURE_PRESETS.standard.minActiveSeconds);

    const custom = await mockApi.putSettings({
      captureRules: { preset: "custom", minActiveSeconds: 42 }
    });
    expect(custom.captureRules.preset).toBe("custom");
    expect(custom.captureRules.minActiveSeconds).toBe(42);

    const drifted = await mockApi.putSettings({
      captureRules: { minActiveSeconds: 12 }
    });
    expect(drifted.captureRules.preset).toBe("custom");
    expect(drifted.captureRules.minActiveSeconds).toBe(12);
  });
});
