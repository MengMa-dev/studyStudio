import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { useOrganizeStore } from "@/stores/organize";

/** Inbox-level pending hint; counts come from the「待整理」preview so KB-only edits are not mixed in. */
export function InboxOrganizeHint({ selectedItemIds }: { selectedItemIds: string[] }) {
  const openOrganize = useOrganizeStore((state) => state.openDialog);
  const active = useOrganizeStore((state) => state.active);
  const preview = useQuery({
    queryKey: ["organize-preview", "inbox_pending", "", ""],
    queryFn: () => api.previewOrganize({ scope: "inbox_pending", itemIds: [], entryIds: [] })
  });
  const data = preview.data;
  if (active || !data || !data.itemCount) return null;
  const parts = [
    data.newItemCount ? `${data.newItemCount} 条新内容待整理` : "",
    data.editedItemCount ? `${data.editedItemCount} 条编辑后尚未整理` : "",
    data.newNoteCount ? `${data.newNoteCount} 条新备注未用于整理` : ""
  ].filter(Boolean);
  return (
    <div className="pending-bar inbox-organize-hint" role="note">
      {parts.length ? parts.join("，") : `${data.itemCount} 条内容待整理`}
      <div className="grow" />
      <button
        type="button"
        className="btn sm"
        data-organize-scope="inbox"
        onClick={() =>
          openOrganize({
            scopes: selectedItemIds.length ? ["inbox_selected", "inbox_pending", "inbox_all"] : ["inbox_pending", "inbox_all"],
            defaultScope: "inbox_pending",
            itemIds: selectedItemIds
          })
        }
      >
        ✦ 整理
      </button>
    </div>
  );
}
