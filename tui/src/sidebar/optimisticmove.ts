import { topUnpinnedOrder, type SidebarItemRef } from "../messages";
import type { MoveSidebarItemsOptions } from "../protocol";
import { reconcileNotificationMutes } from "./folders";
import { sidebarItemKey as itemKey } from "./items";
import { compareSidebarOrder } from "./order";
import { nextSidebarMoveReqId, recordPendingSidebarMove, sidebarMoveLabel, type PendingPlacement } from "./pendingmoves";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";
import { syncSelectedIndex } from "./updates";

type SidebarPlacementEntry = {
  item: SidebarItemRef;
  id: string;
  pinned: boolean;
  sortOrder: number;
};

function sidebarPlacementEntries(sidebar: SidebarState, parentId: string | null): SidebarPlacementEntry[] {
  return [
    ...sidebar.conversations
      .filter(conversation => (conversation.folderId ?? null) === parentId)
      .map(conversation => ({
        item: { type: "conversation" as const, id: conversation.id },
        id: conversation.id,
        pinned: conversation.pinned,
        sortOrder: conversation.sortOrder,
      })),
    ...sidebar.folders
      .filter(folder => (folder.parentId ?? null) === parentId)
      .map(folder => ({
        item: { type: "folder" as const, id: folder.id },
        id: folder.id,
        pinned: folder.pinned,
        sortOrder: folder.sortOrder,
      })),
  ].sort(compareSidebarOrder);
}

function sidebarItemParent(sidebar: SidebarState, item: SidebarItemRef): string | null {
  if (item.type === "conversation") return sidebar.conversations.find(conversation => conversation.id === item.id)?.folderId ?? null;
  return sidebar.folders.find(folder => folder.id === item.id)?.parentId ?? null;
}

function sidebarItemPinned(sidebar: SidebarState, item: SidebarItemRef): boolean | undefined {
  if (item.type === "conversation") return sidebar.conversations.find(conversation => conversation.id === item.id)?.pinned;
  return sidebar.folders.find(folder => folder.id === item.id)?.pinned;
}

function isFolderDescendant(sidebar: SidebarState, folderId: string, candidateParentId: string | null): boolean {
  let current = candidateParentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === folderId) return true;
    seen.add(current);
    current = sidebar.folders.find(folder => folder.id === current)?.parentId ?? null;
  }
  return false;
}

/**
 * Immediately project a daemon-owned move into the local sidebar.
 *
 * This intentionally mirrors conversations.moveSidebarItems so the subsequent
 * authoritative patch normally changes no visible placement. If the daemon had
 * newer state, its patch (or failure snapshot) simply replaces this projection.
 */
export function applyOptimisticSidebarItemsMove(
  sidebar: SidebarState,
  items: SidebarItemRef[],
  parentId: string | null,
  before?: SidebarItemRef,
  options: MoveSidebarItemsOptions = {},
): boolean {
  return projectSidebarItemsMove(sidebar, items, parentId, before, options) !== null;
}

function projectSidebarItemsMove(
  sidebar: SidebarState,
  items: SidebarItemRef[],
  parentId: string | null,
  before: SidebarItemRef | undefined,
  options: MoveSidebarItemsOptions,
): Map<string, PendingPlacement> | null {
  const safeParent = parentId && sidebar.folders.some(folder => folder.id === parentId) ? parentId : null;
  const seen = new Set<string>();
  const movableItems: SidebarItemRef[] = [];

  for (const item of items) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (item.type === "conversation") {
      if (!sidebar.conversations.some(conversation => conversation.id === item.id)) continue;
    } else {
      if (!sidebar.folders.some(folder => folder.id === item.id)) continue;
      if (item.id === safeParent || isFolderDescendant(sidebar, item.id, safeParent)) continue;
    }
    movableItems.push(item);
  }
  if (movableItems.length === 0) return null;

  const movingKeys = new Set(movableItems.map(itemKey));
  const allDestinationEntries = sidebarPlacementEntries(sidebar, safeParent);
  const destinationEntries = allDestinationEntries.filter(entry => !movingKeys.has(itemKey(entry.item)));
  const preservedPinned = options.preservePinned ? sidebarItemPinned(sidebar, movableItems[0]!) : undefined;
  const hasHomogeneousPinnedState = preservedPinned !== undefined
    && movableItems.every(item => sidebarItemPinned(sidebar, item) === preservedPinned);
  const anchorEntries = hasHomogeneousPinnedState
    ? destinationEntries.filter(entry => entry.pinned === preservedPinned)
    : destinationEntries;
  const beforeEntry = before && sidebarItemParent(sidebar, before) === safeParent
    ? anchorEntries.find(entry => itemKey(entry.item) === itemKey(before))
    : undefined;
  const beforeIndex = beforeEntry ? anchorEntries.indexOf(beforeEntry) : -1;
  const previousEntry = beforeIndex > 0 ? anchorEntries[beforeIndex - 1] : undefined;

  let startOrder: number;
  let step: number;
  if (beforeEntry) {
    startOrder = previousEntry
      ? previousEntry.sortOrder + ((beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1))
      : beforeEntry.sortOrder - movableItems.length;
    step = previousEntry ? (beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1) : 1;
  } else if (options.placement === "bottom") {
    const placementEntries = hasHomogeneousPinnedState ? anchorEntries : destinationEntries;
    const maxOrder = placementEntries.reduce((max, entry) => Math.max(max, entry.sortOrder), -Infinity);
    startOrder = maxOrder === -Infinity ? 0 : maxOrder + 1;
    step = 1;
  } else {
    startOrder = topUnpinnedOrder(allDestinationEntries) - movableItems.length;
    step = 1;
  }

  let order = startOrder - step;
  const now = Date.now();
  const placements = new Map<string, PendingPlacement>();
  for (const item of movableItems) {
    order += step;
    const pinned = options.preservePinned ? sidebarItemPinned(sidebar, item) ?? false : false;
    if (item.type === "conversation") {
      const conversation = sidebar.conversations.find(candidate => candidate.id === item.id);
      if (!conversation) continue;
      conversation.folderId = safeParent;
      conversation.pinned = pinned;
      conversation.sortOrder = order;
      placements.set(itemKey(item)!, { sortOrder: order, parentId: safeParent, pinned });
    } else {
      const folder = sidebar.folders.find(candidate => candidate.id === item.id);
      if (!folder) continue;
      folder.parentId = safeParent;
      folder.pinned = pinned;
      folder.sortOrder = order;
      folder.updatedAt = now;
      placements.set(itemKey(item)!, { sortOrder: order, parentId: safeParent, pinned });
    }
  }

  reconcileNotificationMutes(sidebar);
  syncSelectedIndex(sidebar);
  return placements;
}

/**
 * Show a user-initiated move at once and remember it until the daemon answers,
 * so the answer (or a later one for a repeated press) is not replayed over it.
 * Returns the request id to send with the command, or null when nothing moved.
 * `focus` is the row to keep the cursor on when the items leave the view.
 */
export function applyPendingSidebarItemsMove(
  sidebar: SidebarState,
  items: SidebarItemRef[],
  parentId: string | null,
  before: SidebarItemRef | undefined,
  options: MoveSidebarItemsOptions,
  focus?: SidebarState["pendingFocusItem"],
): string | null {
  const placements = projectSidebarItemsMove(sidebar, items, parentId, before, options);
  if (!placements) return null;
  if (focus) focusSidebarItem(sidebar, focus);
  const reqId = nextSidebarMoveReqId();
  recordPendingSidebarMove(sidebar, { reqId, kind: "items", label: sidebarMoveLabel(sidebar, items), expected: placements });
  return reqId;
}

/**
 * Swap an item with its neighbour now, as the daemon's moveSidebarItem will.
 * Returns the request id to send, or null when the daemon would refuse (an
 * edge, or a neighbour on the other side of the pinned boundary).
 */
export function applyPendingSidebarItemReorder(
  sidebar: SidebarState,
  item: SidebarItemRef,
  direction: "up" | "down",
): string | null {
  const parentId = sidebarItemParent(sidebar, item);
  const pinned = sidebarItemPinned(sidebar, item);
  if (pinned === undefined) return null;
  const siblings = sidebarPlacementEntries(sidebar, parentId);
  const index = siblings.findIndex(entry => itemKey(entry.item) === itemKey(item));
  if (index === -1) return null;
  const target = siblings[direction === "up" ? index - 1 : index + 1];
  if (!target || target.pinned !== pinned) return null;

  const currentOrder = siblings[index]!.sortOrder;
  const movedOrder = target.sortOrder === currentOrder ? currentOrder + (direction === "up" ? -0.5 : 0.5) : target.sortOrder;
  const label = sidebarMoveLabel(sidebar, [item]);
  for (const [ref, order] of [[item, movedOrder], [target.item, currentOrder]] as const) {
    const row = ref.type === "conversation"
      ? sidebar.conversations.find(conversation => conversation.id === ref.id)
      : sidebar.folders.find(folder => folder.id === ref.id);
    if (row) row.sortOrder = order;
  }
  const reqId = nextSidebarMoveReqId();
  recordPendingSidebarMove(sidebar, {
    reqId,
    kind: "reorder",
    label,
    expected: new Map([[itemKey(item)!, { sortOrder: movedOrder }], [itemKey(target.item)!, { sortOrder: currentOrder }]]),
  });
  syncSelectedIndex(sidebar);
  return reqId;
}
