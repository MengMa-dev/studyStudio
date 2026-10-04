import { Link } from "@tanstack/react-router";
import { masteryColor, masteryPercent } from "@/lib/kb";

export function ConceptChip({ id, name, mastery }: { id: string; name: string; mastery: number | null }) {
  return (
    <Link to="/wiki/$entryId" params={{ entryId: id }} className="concept-chip" title={name}>
      <i style={{ background: masteryColor(mastery) }} />
      <b className="concept-name">{name}</b>
      <span>{masteryPercent(mastery)}</span>
    </Link>
  );
}
