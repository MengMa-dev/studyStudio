export type SelectionId = string;

export type SelectionState = {
  selected: Set<SelectionId>;
};

export function createSelection(ids: SelectionId[] = []): SelectionState {
  return { selected: new Set(ids) };
}

export function toggleSelection(state: SelectionState, id: SelectionId): SelectionState {
  const selected = new Set(state.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { selected };
}

/** Select-all only applies to the current page ids; keeps cross-page selections. */
export function applySelectAllPage(state: SelectionState, pageIds: SelectionId[], checked: boolean): SelectionState {
  const selected = new Set(state.selected);
  for (const id of pageIds) {
    if (checked) selected.add(id);
    else selected.delete(id);
  }
  return { selected };
}

export function clearSelection(): SelectionState {
  return { selected: new Set() };
}

export function partitionSelection(selected: Set<SelectionId>, itemIds: Iterable<SelectionId>): { itemIds: string[]; noteIds: string[] } {
  const itemSet = new Set(itemIds);
  const items: string[] = [];
  const notes: string[] = [];
  for (const id of selected) {
    if (itemSet.has(id)) items.push(id);
    else notes.push(id);
  }
  return { itemIds: items, noteIds: notes };
}

export function pageSelectionStats(selected: Set<SelectionId>, pageIds: SelectionId[]) {
  const picked = pageIds.filter((id) => selected.has(id)).length;
  return {
    picked,
    allChecked: pageIds.length > 0 && picked === pageIds.length,
    partial: picked > 0 && picked < pageIds.length,
    hidden: selected.size - picked
  };
}
