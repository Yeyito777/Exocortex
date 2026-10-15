import type { SidebarItemRef } from "../messages";
import type { SidebarItemOrderUpdate, SidebarStatePatchedEvent } from "../protocol";
import { sidebarItemKey as itemKey } from "./items";
import type { SidebarState } from "./state";

/** How long an unanswered move keeps masking authoritative state. */
const PENDING_MOVE_TTL_MS = 10_000;

/** Where one item was put by a local move. Absent fields were not touched. */
export interface PendingPlacement {
  sortOrder: number;
  parentId?: string | null;
  pinned?: boolean;
}

/**
 * A move shown locally before the daemon answered. The daemon echoes it as an
 * absolute order delta or state patch, possibly after later presses were also
 * shown, so the echo is matched to its entry and ignored instead of replayed.
 */
export interface PendingSidebarMove {
  reqId: string;
  kind: "reorder" | "items";
  label: string;
  /** Placement per item key, exactly as projected locally. */
  expected: Map<string, PendingPlacement>;
  acknowledged: boolean;
  expiresAt: number;
}

let nextMoveId = 0;

export function nextSidebarMoveReqId(): string {
  return `sidebar_move_${++nextMoveId}_${Date.now()}`;
}

function prune(sidebar: SidebarState): void {
  const now = Date.now();
  sidebar.pendingMoves = sidebar.pendingMoves.filter(move => move.expiresAt > now);
  // Once every earlier press is answered, the later ones carry the final state.
  while (sidebar.pendingMoves[0]?.acknowledged) sidebar.pendingMoves.shift();
}

export function recordPendingSidebarMove(
  sidebar: SidebarState,
  move: Omit<PendingSidebarMove, "acknowledged" | "expiresAt">,
): void {
  prune(sidebar);
  sidebar.pendingMoves.push({ ...move, acknowledged: false, expiresAt: Date.now() + PENDING_MOVE_TTL_MS });
}

function findUnacknowledged(sidebar: SidebarState, predicate: (move: PendingSidebarMove) => boolean): PendingSidebarMove | undefined {
  return sidebar.pendingMoves.find(move => !move.acknowledged && predicate(move));
}

/**
 * Whether a `sidebar_items_reordered` echo answers a pending reorder. When the
 * daemon chose different orders than projected, its values replace the
 * projection. Returns the (possibly adjusted) updates to apply, or null when the
 * local state already shows them.
 */
export function acknowledgeReorderEcho(sidebar: SidebarState, updates: SidebarItemOrderUpdate[]): SidebarItemOrderUpdate[] | null {
  prune(sidebar);
  if (sidebar.pendingMoves.length === 0) return updates;
  const keys = updates.map(update => itemKey(update.item)).sort().join("|");
  const move = findUnacknowledged(sidebar, candidate =>
    candidate.kind === "reorder" && [...candidate.expected.keys()].sort().join("|") === keys);
  if (!move) return updates;
  move.acknowledged = true;
  const differing = updates.filter(update => move.expected.get(itemKey(update.item)!)?.sortOrder !== update.sortOrder);
  for (const update of differing) move.expected.get(itemKey(update.item)!)!.sortOrder = update.sortOrder;
  prune(sidebar);
  return differing.length > 0 ? updates : null;
}

/**
 * Whether a state patch answers a pending item move. One that only restates the
 * projected placements is already shown and is skipped (returns true). One that
 * touches the same items with other values is still its answer: the daemon's
 * values replace the projection and the patch is applied (returns false).
 */
export function acknowledgePatchEcho(sidebar: SidebarState, patch: SidebarStatePatchedEvent): boolean {
  prune(sidebar);
  if (sidebar.pendingMoves.length === 0) return false;
  if ((patch.removedConversationIds?.length ?? 0) > 0 || (patch.removedFolderIds?.length ?? 0) > 0) return false;
  const upserts: { key: string; parentId: string | null; pinned: boolean; sortOrder: number }[] = [
    ...(patch.conversations ?? []).map(conv => ({ key: `conversation:${conv.id}`, parentId: conv.folderId ?? null, pinned: conv.pinned, sortOrder: conv.sortOrder })),
    ...(patch.folders ?? []).map(folder => ({ key: `folder:${folder.id}`, parentId: folder.parentId ?? null, pinned: folder.pinned, sortOrder: folder.sortOrder })),
  ];
  if (upserts.length === 0) return false;
  const exact = findUnacknowledged(sidebar, candidate => candidate.kind === "items" && upserts.every(upsert => {
    const placement = candidate.expected.get(upsert.key);
    return placement !== undefined
      && placement.sortOrder === upsert.sortOrder
      && (placement.parentId === undefined || placement.parentId === upsert.parentId)
      && (placement.pinned === undefined || placement.pinned === upsert.pinned);
  }));
  if (exact) {
    exact.acknowledged = true;
    prune(sidebar);
    return true;
  }
  const answered = findUnacknowledged(sidebar, candidate =>
    candidate.kind === "items" && upserts.every(upsert => candidate.expected.has(upsert.key)));
  if (!answered) return false;
  answered.acknowledged = true;
  for (const upsert of upserts) answered.expected.set(upsert.key, { sortOrder: upsert.sortOrder, parentId: upsert.parentId, pinned: upsert.pinned });
  return false;
}

/**
 * A full list that already shows a pending move acknowledges it (older daemons
 * and reconnects answer with snapshots rather than deltas).
 */
function acknowledgeObservedMoves(sidebar: SidebarState): void {
  for (const move of sidebar.pendingMoves) {
    if (move.acknowledged) continue;
    let shown = true;
    for (const [key, placement] of move.expected) {
      const current = currentPlacement(sidebar, key);
      if (!current || current.sortOrder !== placement.sortOrder
          || (placement.parentId !== undefined && current.parentId !== placement.parentId)
          || (placement.pinned !== undefined && current.pinned !== placement.pinned)) {
        shown = false;
        break;
      }
    }
    if (shown) move.acknowledged = true;
  }
}

function currentPlacement(sidebar: SidebarState, key: string): { sortOrder: number; parentId: string | null; pinned: boolean } | null {
  const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (type === "conversation") {
    const conv = sidebar.conversations.find(candidate => candidate.id === id);
    return conv ? { sortOrder: conv.sortOrder, parentId: conv.folderId ?? null, pinned: conv.pinned } : null;
  }
  const folder = sidebar.folders.find(candidate => candidate.id === id);
  return folder ? { sortOrder: folder.sortOrder, parentId: folder.parentId ?? null, pinned: folder.pinned } : null;
}

/**
 * Re-project every move the daemon has not settled onto freshly received
 * authoritative state, so an unrelated update cannot flicker them back. The
 * projection assigns absolute values, so repeating it is harmless. The caller
 * re-sorts.
 */
export function overlayPendingSidebarMoves(sidebar: SidebarState): void {
  prune(sidebar);
  if (sidebar.pendingMoves.length === 0) return;
  acknowledgeObservedMoves(sidebar);
  for (const move of sidebar.pendingMoves) {
    for (const [key, placement] of move.expected) {
      const type = key.slice(0, key.indexOf(":"));
      const id = key.slice(key.indexOf(":") + 1);
      if (type === "conversation") {
        const conv = sidebar.conversations.find(candidate => candidate.id === id);
        if (!conv) continue;
        conv.sortOrder = placement.sortOrder;
        if (placement.parentId !== undefined) conv.folderId = placement.parentId;
        if (placement.pinned !== undefined) conv.pinned = placement.pinned;
      } else {
        const folder = sidebar.folders.find(candidate => candidate.id === id);
        if (!folder) continue;
        folder.sortOrder = placement.sortOrder;
        if (placement.parentId !== undefined) folder.parentId = placement.parentId;
        if (placement.pinned !== undefined) folder.pinned = placement.pinned;
      }
    }
  }
  prune(sidebar);
}

/**
 * The daemon refused a move. The rejected move and every later one were built
 * on a state that never existed, so all are dropped and the authoritative list
 * that accompanies the rejection takes over. Returns the rejected move.
 */
export function rejectPendingSidebarMove(sidebar: SidebarState, reqId: string | undefined): PendingSidebarMove | null {
  if (!reqId) return null;
  const index = sidebar.pendingMoves.findIndex(move => move.reqId === reqId);
  if (index === -1) return null;
  const [rejected] = sidebar.pendingMoves.splice(index);
  return rejected ?? null;
}

export function sidebarMoveLabel(sidebar: SidebarState, items: SidebarItemRef[]): string {
  if (items.length !== 1) return `${items.length} items`;
  const item = items[0]!;
  return item.type === "folder"
    ? sidebar.folders.find(folder => folder.id === item.id)?.name ?? "folder"
    : sidebar.conversations.find(conv => conv.id === item.id)?.title ?? "conversation";
}
