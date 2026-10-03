import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StudyChatMessage } from "@/lib/chat";
import { renderWithQuery } from "@/test/render";
import { linkCitations } from "./ChatMarkdown";
import { ChatMessage } from "./ChatMessage";

vi.mock("@tanstack/react-router", () => import("@/test/router-mock"));

describe("ChatMessage 引用渲染", () => {
  it("只有 data-citations 中存在的 [n] 渲染为上标链接，其余保持纯文本", () => {
    const message: StudyChatMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "交叉编码器更准 [1]，但不能离线 [5]。" },
        { type: "data-citations", data: { citations: [{ n: 1, kind: "entry", id: "kb-cross", title: "交叉编码器" }], nonRecord: false } }
      ]
    };
    const { container } = renderWithQuery(<ChatMessage message={message} />);
    const sups = container.querySelectorAll(".chat-cite a");
    expect(sups).toHaveLength(1);
    expect(sups[0]).toHaveAttribute("href", "#/wiki/kb-cross");
    expect(container.querySelector(".prose")).toHaveTextContent("但不能离线 [5]。");
    expect(screen.queryByText("非学习记录")).not.toBeInTheDocument();
  });

  it("代码块中的 [n] 不替换", () => {
    expect(linkCitations("见 [1]\n```\narr[1]\n```", new Set([1]))).toBe("见 [1](#cite-1)\n```\narr[1]\n```");
  });

  it("全角【n】与 [1, 2] 列表拆成独立上标", () => {
    expect(linkCitations("时长【1】，见 [1, 2]、【2、9】", new Set([1, 2]))).toBe("时长[1](#cite-1)，见 [1](#cite-1)[2](#cite-2)、[2](#cite-2)\\[9\\]");
  });
});
