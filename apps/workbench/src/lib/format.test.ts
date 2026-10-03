import { describe, expect, it } from "vitest";
import { formatCapturedAt, formatClock } from "@/lib/format";

describe("时间显示使用本地时区", () => {
  const now = new Date(2026, 9, 3, 20, 0);

  it("今天/昨天/更早按本地日期判断", () => {
    expect(formatCapturedAt(new Date(2026, 9, 3, 3, 5).toISOString(), now)).toBe("今天 03:05");
    expect(formatCapturedAt(new Date(2026, 9, 2, 23, 59).toISOString(), now)).toBe("昨天 23:59");
    expect(formatCapturedAt(new Date(2026, 8, 30, 8, 0).toISOString(), now)).toBe("9月30日 08:00");
  });

  it("时钟显示本地时分", () => {
    expect(formatClock(new Date(2026, 9, 3, 15, 33).toISOString())).toBe("15:33");
  });
});
