import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { STAGE_LABEL } from "@/lib/kb";
import { useOrganizeStore } from "@/stores/organize";

/** Sidebar progress for the running organize batch (07「运行中：侧栏显示进度」). */
export function OrganizeIndicator() {
  const active = useOrganizeStore((state) => state.active);

  useEffect(() => {
    document.body.classList.toggle("is-organizing", Boolean(active));
    return () => document.body.classList.remove("is-organizing");
  }, [active]);

  if (!active) return null;
  const percent = active.total ? Math.round((active.done / active.total) * 100) : 0;
  const detail = [active.stage ? STAGE_LABEL[active.stage] : "准备中", active.currentTitle].filter(Boolean).join(" · ");
  return (
    <Link to="/runs/$runId" params={{ runId: active.runId }} className="organizing" title={detail} role="status">
      <span className="spinner" />
      <span className="grow" style={{ minWidth: 0 }}>
        整理中 {active.done}/{active.total || "…"}
        <span className="organizing-stage">{detail}</span>
      </span>
      <span className="faint">{percent}%</span>
    </Link>
  );
}
