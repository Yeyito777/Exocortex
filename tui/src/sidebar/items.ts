import type { SidebarItemRef } from "../messages";

export type SidebarSelectableItem = SidebarItemRef | { type: "up" };

export function sameSidebarItem(
  a: SidebarSelectableItem | null,
  b: SidebarSelectableItem | null,
): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "up" || ("id" in a && "id" in b && a.id === b.id);
}

export function sidebarItemKey(item: SidebarSelectableItem | null): string | null {
  if (!item) return null;
  return item.type === "up" ? "up" : `${item.type}:${item.id}`;
}
