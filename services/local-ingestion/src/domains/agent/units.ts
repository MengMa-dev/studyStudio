import type { DatabaseSync } from "node:sqlite";
import { buildUnits } from "../organize/pipeline.js";
import type { WorkUnit } from "../organize/process.js";
import { loadItems } from "../organize/store.js";

/** Inbox units for agents: pending / failed items grouped like the pipeline (conversation threads → one unit). */

export function unitKey(unit: WorkUnit): string {
  return unit.items[0]!.id;
}

export function pendingUnits(db: DatabaseSync): WorkUnit[] {
  const ids = (
    db.prepare("SELECT id FROM items WHERE deleted_at IS NULL AND organize_status IN ('pending', 'failed') ORDER BY captured_at").all() as Array<{ id: string }>
  ).map((row) => row.id);
  return buildUnits([...loadItems(db, ids).values()], () => "strong", null, { path: "direct", adoptOf: () => false });
}

export function findUnit(db: DatabaseSync, key: string): WorkUnit | null {
  return pendingUnits(db).find((unit) => unitKey(unit) === key) ?? null;
}
