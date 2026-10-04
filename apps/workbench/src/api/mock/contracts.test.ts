import { beforeEach, describe, expect, it } from "vitest";
import type { OrganizeEvent } from "@study-studio/shared";
import { mockApi, resetMockState } from "@/api";
import { setMockOrganizeTickMs, waitForMockOrganizeIdle } from "./organize";

describe("mock 知识库 / 整理 / AI 接口符合共享契约", () => {
  beforeEach(() => {
    resetMockState();
    setMockOrganizeTickMs(0);
  });

  it("知识图谱", async () => {
    const graph = await mockApi.getKbGraph();
    expect(graph.edges).toContainEqual({ src: "kb-cross", dst: "kb-rerank", type: "part_of" });
    expect(graph.nodes.find((node) => node.id === "kb-prompt-cache")?.categoryId).toBeNull();
    await mockApi.deleteKbEntries({ ids: ["kb-cross"] });
    const after = await mockApi.getKbGraph();
    expect(after.nodes.some((node) => node.id === "kb-cross")).toBe(false);
    expect(after.edges.some((edge) => edge.src === "kb-cross" || edge.dst === "kb-cross")).toBe(false);
  });

  it("词条类型：列表、改名合并、编辑类型", async () => {
    const { kinds } = await mockApi.getKbKinds();
    expect(kinds.slice(0, 3).map((kind) => kind.name)).toEqual(["概念", "方法", "算法"]);
    expect(kinds.find((kind) => kind.name === "工具")).toEqual({ name: "工具", entryCount: 0, seed: true });
    const count = (list: typeof kinds, name: string) => list.find((kind) => kind.name === name)?.entryCount;

    expect(await mockApi.renameKbKind({ from: "论文", to: "论文" })).toEqual({ updated: 0 });
    expect(await mockApi.renameKbKind({ from: "论文", to: "概念" })).toEqual({ updated: count(kinds, "论文") });
    const merged = (await mockApi.getKbKinds()).kinds;
    expect(count(merged, "概念")).toBe(count(kinds, "概念")! + count(kinds, "论文")!);
    expect(count(merged, "论文")).toBe(0);

    await mockApi.patchKbEntry("kb-bm25", { kind: "评测指标" });
    const custom = (await mockApi.getKbKinds()).kinds;
    expect(custom.at(-1)).toEqual({ name: "评测指标", entryCount: 1, seed: false });
    expect((await mockApi.getKbEntry("kb-bm25")).kind).toBe("评测指标");
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
    await expect(mockApi.runOrganize({ scope: "kb_all" })).rejects.toThrow(/run_in_progress/);
    await waitForMockOrganizeIdle();
    unsubscribe();
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(types).toContain("run_progress");
    expect(types).toContain("item_done");

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
