/** Shared sidebar ordering helpers for conversations and folders. */

export function compareSidebarOrder<T extends { pinned: boolean; sortOrder: number }>(a: T, b: T): number {
  return (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder;
}
