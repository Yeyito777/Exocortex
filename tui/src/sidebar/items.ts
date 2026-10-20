import type { SidebarItemRef } from "../messages";

export type SidebarSelectableItem = SidebarItemRef | { type: "up" };

export function isMovableSidebarItem(item: SidebarSelectableItem | null): item is SidebarItemRef {
  return item?.type === "conversation" || item?.type === "folder";
}

export function sameSidebarItem(
  a: SidebarSelectableItem | null,
  b: SidebarSelectableItem | null,
): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "up") return true;
  return "id" in a && "id" in b && a.id === b.id;
}

export function sidebarItemKey(item: SidebarSelectableItem | null): string | null {
  if (!item) return null;
  if (item.type === "up") return "up";
  return `${item.type}:${item.id}`;
}
