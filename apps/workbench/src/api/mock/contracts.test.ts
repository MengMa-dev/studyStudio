import { beforeEach, describe, expect, it } from "vitest";
import type { OrganizeEvent } from "@study-studio/shared";
import { mockApi, resetMockState } from "@/api";

describe("mock 知识库 / 整理 / AI 接口符合共享契约", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("知识库目录、详情、编辑与删除", async () => {
    const tree = await mockApi.getKbTree();
    expect(tree.mode).toBe("tree");
    const rerank = tree.categories[0]?.children.find((node) => node.id === "kb-rerank");
    expect(rerank?.children.map((node) => node.id)).toContain("kb-cross");

    const flat = await mockApi.getKbTree({ q: "hnsw" });
    expect(flat.mode).toBe("flat");
    expect(flat.entries.map((entry) => entry.id)).toEqual(["kb-hnsw"]);

    const detail = await mockApi.getKbEntry("kb-cross");
    expect(detail.suggestRewrite).toBe(true);
    expect(detail.breadcrumb.map((crumb) => crumb.name)).toEqual(["检索", "重排", "交叉编码器"]);

    const edited = await mockApi.patchKbEntry("kb-cross", { bodyMarkdown: "## 新正文", mastery: 0.9 });
    expect(edited.userEdited && edited.dirty).toBe(true);
    expect(edited.masterySource).toBe("user");

    const impact = await mockApi.getKbDeleteImpact(["kb-rerank"]);
    expect(impact.reparentedChildren.map((child) => child.id)).toEqual(["kb-cross"]);
    const deleted = await mockApi.deleteKbEntries({ ids: ["kb-rerank"], ignore: true });
    expect(deleted.deletedEntryCount).toBe(1);
  });

  it("整理设置、发起、记录与事件", async () => {
    const settings = await mockApi.putOrganizeSettings({ triggers: { batch: { count: 20 } } });
    expect(settings.settings.triggers.batch).toEqual({ enabled: true, count: 20 });

    await expect(mockApi.runOrganize({ scope: "inbox_selected" })).rejects.toThrow();

    const events: OrganizeEvent[] = [];
    const unsubscribe = mockApi.subscribeOrganizeEvents((event) => events.push(event));
    const started = await mockApi.runOrganize({ scope: "item", itemIds: ["item-p1"], requirement: "重点看原理" });
    unsubscribe();
    expect(events.map((event) => event.type)).toEqual(["run_started", "run_finished"]);

    const runs = await mockApi.listOrganizeRuns();
    expect(runs.runs[0]?.id).toBe(started.run.id);
    const detail = await mockApi.getOrganizeRun("run-1");
    expect(detail.failures).toHaveLength(1);
    const retried = await mockApi.retryOrganizeRun("run-1");
    expect(retried.run.trigger).toBe("retry");
  });

  it("AI 服务商、任务模型与用量", async () => {
    const { providers } = await mockApi.listAiProviders();
    const gemini = providers.find((provider) => provider.id === "gemini");
    expect(gemini?.apiKeyMasked).toBe("AIz…1234");
    expect(JSON.stringify(providers)).not.toContain("AIzaSyMockKey1234");

    const created = await mockApi.createAiProvider({ name: "Groq", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" });
    const test = await mockApi.testAiProvider(created.id, { apiKey: "gsk-test" });
    expect(test.ok).toBe(true);

    const tasks = await mockApi.putAiTasks({ tasks: [{ task: "learning_judge", providerId: created.id, model: "openai/gpt-oss-120b" }] });
    expect(tasks.tasks.find((task) => task.task === "learning_judge")?.fallbackModel).toBeNull();

    await mockApi.putAiLimits({ dailyTokenLimit: null });
    const usage = await mockApi.getAiUsage("2026-10-03");
    expect(usage.dailyTokenLimit).toBeNull();
    expect(usage.limitReached).toBe(false);
  });
});
