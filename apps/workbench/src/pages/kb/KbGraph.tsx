import type { KbGraphResponse, KbRelationType } from "@study-studio/shared";
import cytoscape, { type Core, type StylesheetJson } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";
import { EDGE_COLOR, focusSets, graphSignature, toElements } from "@/lib/kb-graph";

cytoscape.use(fcose);

const STYLE: StylesheetJson = [
  {
    selector: "node.entry",
    style: {
      "background-color": "data(color)",
      width: "data(size)",
      height: "data(size)",
      label: "data(label)",
      "font-size": 13,
      color: "#212529",
      "text-valign": "bottom",
      "text-margin-y": 4,
      "min-zoomed-font-size": 8,
      "border-width": 2,
      "border-color": "#fff"
    }
  },
  {
    selector: "node.category",
    style: {
      shape: "round-rectangle",
      "background-color": "#f1f3f5",
      "background-opacity": 0.7,
      "border-width": 1,
      "border-color": "#dee2e6",
      label: "data(label)",
      "font-size": 12,
      color: "#868e96",
      "text-valign": "top",
      "text-halign": "center",
      "text-margin-y": -4,
      "min-zoomed-font-size": 8,
      padding: "12px"
    }
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8
    }
  },
  ...Object.entries(EDGE_COLOR).map(([type, color]) => ({
    selector: `edge.${type}`,
    style: { "line-color": color, "target-arrow-color": color }
  })),
  { selector: "edge.contrasts", style: { "line-style": "dashed" } },
  { selector: "node.entry.focus", style: { "border-width": 4, "border-color": "#212529" } },
  { selector: ".dim", style: { opacity: 0.15 } },
  { selector: ".filtered", style: { display: "none" } }
];

export function KbGraph(props: {
  graph: KbGraphResponse;
  checked: string[];
  relation: KbRelationType | "all";
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  /** Mini graph on the entry page: no legend, no wheel zoom (keeps page scroll), `centerId` outlined. */
  compact?: boolean;
  centerId?: string;
}) {
  const { graph, checked, relation, compact, centerId } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const signatureRef = useRef<string | null>(null);
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    const cy = cytoscape({ container: containerRef.current, style: STYLE, minZoom: 0.2, maxZoom: 3, userZoomingEnabled: !handlers.current.compact });
    // Core-level only: element taps bubble through compound parents to the core once, with the original target.
    cy.on("tap", (e) => {
      if (e.target !== cy && e.target.hasClass("entry")) handlers.current.onToggle(e.target.id());
    });
    cy.on("dbltap", "node.entry", (e) => handlers.current.onOpen(e.target.id()));
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
      signatureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current!;
    const signature = graphSignature(graph);
    if (signature === signatureRef.current) {
      cy.json({ elements: toElements(graph) });
      return;
    }
    signatureRef.current = signature;
    cy.elements().remove();
    cy.add(toElements(graph));
    cy.resize();
    cy.layout({ name: "fcose", animate: false, nodeDimensionsIncludeLabels: true, packComponents: true } as cytoscape.LayoutOptions).run();
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current!;
    const sets = focusSets(graph, checked);
    cy.batch(() => {
      cy.elements().removeClass("dim focus filtered");
      if (relation !== "all") cy.edges().not(`.${relation}`).addClass("filtered");
      if (centerId) cy.getElementById(centerId).addClass("focus");
      if (!sets) return;
      cy.nodes(".entry").forEach((n) => {
        if (!sets.nodes.has(n.id())) n.addClass("dim");
      });
      cy.edges().forEach((e) => {
        if (!sets.edges.has(e.id())) e.addClass("dim");
      });
      for (const id of checked) cy.getElementById(id).addClass("focus");
    });
  }, [graph, checked, relation, centerId]);

  return (
    <div className="kb-graph">
      <div ref={containerRef} className="kb-graph-canvas" />
      {compact ? null : (
        <div className="kb-graph-legend">
          <div>
            <b>掌握程度</b>：<span style={{ color: "#2f9e44" }}>●</span> 熟悉 <span style={{ color: "#4c6ef5" }}>●</span> 了解{" "}
            <span style={{ color: "#f08c00" }}>●</span> 薄弱 <span style={{ color: "#e03131" }}>●</span> 陌生
          </div>
        </div>
      )}
    </div>
  );
}
