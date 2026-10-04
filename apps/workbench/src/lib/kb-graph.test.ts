import type { KbGraphResponse } from "@study-studio/shared";
import { describe, expect, it } from "vitest";
import { edgeId, egoGraph, focusSets, graphSignature, toElements } from "@/lib/kb-graph";

const node = (id: string, categoryId: string | null) =>
  ({ id, name: id, kind: "concept", categoryId, mastery: 0.5, stale: false, orphan: false }) as KbGraphResponse["nodes"][number];

const graph: KbGraphResponse = {
  categories: [
    { id: "c1", name: "分类一" },
    { id: "c2", name: "分类二" }
  ],
  nodes: [node("a", "c1"), node("b", "c1"), node("c", "c2"), node("d", null)],
  edges: [
    { src: "a", dst: "b", type: "part_of" },
    { src: "c", dst: "a", type: "prerequisite" },
    { src: "b", dst: "d", type: "related" },
    { src: "a", dst: "b", type: "related" }
  ]
};

const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort();

describe("focusSets", () => {
  it("点亮勾选词条，只点亮两端都被勾选的边", () => {
    const f = focusSets(graph, ["b", "d"]);
    expect(sorted(f?.nodes)).toEqual(["b", "d"]);
    expect(sorted(f?.edges)).toEqual(["b|d|related"]);
  });

  it("未勾选返回 null（默认态）", () => {
    expect(focusSets(graph, [])).toBeNull();
  });
});

describe("egoGraph", () => {
  it("只保留自身、直接邻居和与自身相连的边，去掉分类", () => {
    const ego = egoGraph(graph, "b");
    expect(ego.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "d"]);
    expect(ego.edges.map(edgeId).sort()).toEqual(["a|b|part_of", "a|b|related", "b|d|related"]);
    expect(ego.categories).toEqual([]);
    expect(ego.nodes.every((n) => n.categoryId === null)).toBe(true);
  });
});

describe("toElements", () => {
  const elements = toElements(graph);
  const byId = new Map(elements.map((e) => [e.data.id, e]));

  it("复合节点 parent 正确，无分类节点无 parent", () => {
    expect(byId.get("cat:c1")?.data.label).toBe("分类一");
    expect(byId.get("a")?.data.parent).toBe("cat:c1");
    expect(byId.get("c")?.data.parent).toBe("cat:c2");
    expect(byId.get("d")?.data.parent).toBeUndefined();
  });

  it("边 id 唯一，classes 为关系类型", () => {
    const edges = elements.filter((e) => e.data.source);
    expect(new Set(edges.map((e) => e.data.id)).size).toBe(graph.edges.length);
    expect(byId.get(edgeId(graph.edges[1]!))?.classes).toBe("prerequisite");
  });
});

describe("graphSignature", () => {
  it("对节点顺序不敏感，增删边时变化", () => {
    const sig = graphSignature(graph);
    expect(graphSignature({ ...graph, nodes: [...graph.nodes].reverse() })).toBe(sig);
    expect(graphSignature({ ...graph, edges: graph.edges.slice(1) })).not.toBe(sig);
    expect(graphSignature({ ...graph, edges: [...graph.edges, { src: "d", dst: "c", type: "contrasts" }] })).not.toBe(sig);
  });
});
