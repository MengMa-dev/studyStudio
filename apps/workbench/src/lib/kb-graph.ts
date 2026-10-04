import type { KbGraphResponse, KbRelationType } from "@study-studio/shared";
import type { ElementDefinition } from "cytoscape";
import { masteryColor } from "./kb";

export const EDGE_COLOR: Record<KbRelationType, string> = {
  part_of: "#4c6ef5",
  prerequisite: "#f08c00",
  related: "#c3c9d1",
  contrasts: "#e03131"
};

export const edgeId = (e: { src: string; dst: string; type: string }) => `${e.src}|${e.dst}|${e.type}`;

export function toElements(graph: KbGraphResponse): ElementDefinition[] {
  return [
    ...graph.categories.map((c) => ({ data: { id: `cat:${c.id}`, label: c.name }, classes: "category" })),
    ...graph.nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.name,
        parent: n.categoryId ? `cat:${n.categoryId}` : undefined,
        size: 28 + (n.mastery ?? 0) * 28,
        color: masteryColor(n.mastery)
      },
      classes: "entry"
    })),
    ...graph.edges.map((e) => ({ data: { id: edgeId(e), source: e.src, target: e.dst }, classes: e.type }))
  ];
}

/** Null = nothing checked, graph stays in its default (undimmed) state. */
export function focusSets(graph: KbGraphResponse, checked: string[]): { nodes: Set<string>; edges: Set<string> } | null {
  if (!checked.length) return null;
  const nodes = new Set(checked);
  const edges = new Set(graph.edges.filter((e) => nodes.has(e.src) && nodes.has(e.dst)).map(edgeId));
  return { nodes, edges };
}

/** The entry, its direct neighbours and only the edges touching it; categories dropped (no compound boxes). */
export function egoGraph(graph: KbGraphResponse, id: string): KbGraphResponse {
  const edges = graph.edges.filter((e) => e.src === id || e.dst === id);
  const ids = new Set([id, ...edges.flatMap((e) => [e.src, e.dst])]);
  const nodes = graph.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n, categoryId: null }));
  return { categories: [], nodes, edges };
}

export function graphSignature(graph: KbGraphResponse): string {
  const nodes = graph.nodes.map((n) => `${n.id}@${n.categoryId ?? ""}`).sort();
  return [...nodes, "#", ...graph.edges.map(edgeId).sort()].join("\n");
}
