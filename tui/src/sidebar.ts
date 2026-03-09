/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
import { sortConversations } from "./messages";
import { resolveAction } from "./keybinds";
import { theme } from "./theme";

// ── Constants ───────────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 28;

// ── State ───────────────────────────────────────────────────────────

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  selectedIndex: number;
  scrollOffset: number;
  pendingDeleteId: string | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    selectedId: null,
    selectedIndex: 0,
    scrollOffset: 0,
    pendingDeleteId: null,
  };
}

// ── Key handling ────────────────────────────────────────────────────

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "clone_conversation"; convId: string }
  | { type: "unhandled" };

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  const action = resolveAction(key, "navigation");
  if (!action) return { type: "handled" };
  return handleSidebarAction(action, sidebar);
}

/** Handle a semantic action on the sidebar — used by both key handler and vim. */
export function handleSidebarAction(action: string, sidebar: SidebarState): SidebarKeyResult {
  // Any action that isn't "delete" clears the pending delete
  if (action !== "delete") {
    sidebar.pendingDeleteId = null;
  }

  switch (action) {
    case "nav_down":
    case "cursor_down":
      moveSelection(sidebar, 1);
      return { type: "handled" };

    case "nav_up":
    case "cursor_up":
      moveSelection(sidebar, -1);
      return { type: "handled" };

    case "nav_select":
    case "submit":
      if (sidebar.conversations.length > 0) {
        return { type: "select", convId: sidebar.conversations[sidebar.selectedIndex].id };
      }
      return { type: "handled" };

    case "delete": {
      if (sidebar.conversations.length === 0) return { type: "handled" };
      const selectedConv = sidebar.conversations[sidebar.selectedIndex];
      if (!selectedConv) return { type: "handled" };

      if (sidebar.pendingDeleteId === selectedConv.id) {
        // Second d — confirm deletion
        sidebar.pendingDeleteId = null;
        sidebar.conversations.splice(sidebar.selectedIndex, 1);
        syncSelectedIndex(sidebar);
        return { type: "delete_conversation", convId: selectedConv.id };
      }

      // First d — mark for deletion
      sidebar.pendingDeleteId = selectedConv.id;
      return { type: "handled" };
    }

    case "undo_delete":
      return { type: "undo_delete" };

    case "clone": {
      if (sidebar.conversations.length === 0) return { type: "handled" };
      const conv = sidebar.conversations[sidebar.selectedIndex];
      if (!conv) return { type: "handled" };
      return { type: "clone_conversation", convId: conv.id };
    }

    case "mark": {
      if (sidebar.conversations.length === 0) return { type: "handled" };
      const conv = sidebar.conversations[sidebar.selectedIndex];
      if (!conv) return { type: "handled" };
      // Optimistic toggle
      const newMarked = !conv.marked;
      conv.marked = newMarked;
      return { type: "mark_conversation", convId: conv.id, marked: newMarked };
    }

    case "pin": {
      if (sidebar.conversations.length === 0) return { type: "handled" };
      const conv = sidebar.conversations[sidebar.selectedIndex];
      if (!conv) return { type: "handled" };
      const newPinned = !conv.pinned;
      conv.pinned = newPinned;
      sortConversations(sidebar.conversations);
      syncSelectedIndex(sidebar);
      return { type: "pin_conversation", convId: conv.id, pinned: newPinned };
    }

    case "move_up":
    case "move_down": {
      if (sidebar.conversations.length === 0) return { type: "handled" };
      const conv = sidebar.conversations[sidebar.selectedIndex];
      if (!conv) return { type: "handled" };
      const direction = action === "move_up" ? "up" : "down";
      const targetIdx = direction === "up"
        ? sidebar.selectedIndex - 1
        : sidebar.selectedIndex + 1;
      if (targetIdx < 0 || targetIdx >= sidebar.conversations.length) return { type: "handled" };
      const target = sidebar.conversations[targetIdx];
      // Don't cross the pinned/unpinned boundary
      if (target.pinned !== conv.pinned) return { type: "handled" };
      // Optimistic swap
      sidebar.conversations[sidebar.selectedIndex] = target;
      sidebar.conversations[targetIdx] = conv;
      // Swap sortOrder values
      const tmp = conv.sortOrder;
      conv.sortOrder = target.sortOrder;
      target.sortOrder = tmp;
      // Follow the moved item
      sidebar.selectedIndex = targetIdx;
      sidebar.selectedId = conv.id;
      return { type: "move_conversation", convId: conv.id, direction };
    }

    case "focus_prompt":
      return { type: "unhandled" };

    default:
      return { type: "handled" };
  }
}

export function moveSelection(sidebar: SidebarState, delta: number): void {
  sidebar.selectedIndex = Math.max(0, Math.min(
    sidebar.selectedIndex + delta,
    sidebar.conversations.length - 1,
  ));
  sidebar.selectedId = sidebar.conversations[sidebar.selectedIndex]?.id ?? null;
}

// ── State updates ───────────────────────────────────────────────────

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[]): void {
  sidebar.conversations = conversations;
  syncSelectedIndex(sidebar);
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary): void {
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    sidebar.conversations.unshift(summary);
  }
  sortConversations(sidebar.conversations);
  syncSelectedIndex(sidebar);
}

/** Resolve selectedId → selectedIndex after list changes. */
export function syncSelectedIndex(sidebar: SidebarState): void {
  if (sidebar.selectedId) {
    const idx = sidebar.conversations.findIndex(c => c.id === sidebar.selectedId);
    if (idx !== -1) {
      sidebar.selectedIndex = idx;
      return;
    }
  }
  // selectedId not found — default to the first non-pinned conversation
  // so the cursor lands in the active (unpinned) section, not on a pinned item.
  const firstUnpinned = sidebar.conversations.findIndex(c => !c.pinned);
  if (firstUnpinned !== -1) {
    sidebar.selectedIndex = firstUnpinned;
  } else {
    // All pinned (or empty) — fall back to clamped index
    sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, sidebar.conversations.length - 1));
  }
  sidebar.selectedId = sidebar.conversations[sidebar.selectedIndex]?.id ?? null;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Pad or truncate a string to exactly `width` visible characters. */
function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

// ── Rendering ───────────────────────────────────────────────────────

export function renderSidebar(
  sidebar: SidebarState,
  totalRows: number,
  focused: boolean,
  currentConvId: string | null,
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;

  // Row 1: header
  const header = " Conversations";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold +
    pad(header, innerWidth) +
    theme.reset + borderFg + "│" + theme.reset,
  );

  // Row 2: separator with ┤ junction
  rows.push(
    borderFg +
    "─".repeat(innerWidth) + "┤" + theme.reset,
  );

  // Build display rows: section labels + delimiter + conversation entries
  const convs = sidebar.conversations;
  const pinnedCount = convs.filter(c => c.pinned).length;

  interface DisplayRow {
    type: "label" | "delimiter" | "entry";
    convIdx?: number;
    text?: string;
  }
  const displayRows: DisplayRow[] = [];

  if (pinnedCount > 0) {
    displayRows.push({ type: "label", text: " Pinned" });
    for (let i = 0; i < pinnedCount; i++) {
      displayRows.push({ type: "entry", convIdx: i });
    }
    displayRows.push({ type: "delimiter" });
  }
  for (let i = pinnedCount; i < convs.length; i++) {
    displayRows.push({ type: "entry", convIdx: i });
  }

  // Map selectedIndex (into convs[]) to display row index for scroll tracking
  let selectedDisplayIdx = 0;
  for (let di = 0; di < displayRows.length; di++) {
    if (displayRows[di].type === "entry" && displayRows[di].convIdx === sidebar.selectedIndex) {
      selectedDisplayIdx = di;
      break;
    }
  }

  const listRows = totalRows - 2;
  let scrollOffset = sidebar.scrollOffset;
  if (selectedDisplayIdx < scrollOffset) {
    scrollOffset = selectedDisplayIdx;
  } else if (selectedDisplayIdx >= scrollOffset + listRows) {
    scrollOffset = selectedDisplayIdx - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, displayRows.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const di = scrollOffset + i;

    if (di >= displayRows.length) {
      // Empty row
      rows.push(
        theme.sidebarBg +
        " ".repeat(innerWidth) +
        theme.reset + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const dr = displayRows[di];

    if (dr.type === "label") {
      rows.push(
        theme.sidebarBg + theme.text + theme.bold +
        pad(dr.text!, innerWidth) +
        theme.reset + borderFg + "│" + theme.reset,
      );
      continue;
    }

    if (dr.type === "delimiter") {
      rows.push(
        theme.sidebarBg + theme.muted +
        pad(" " + "─".repeat(innerWidth - 2) + " ", innerWidth) +
        theme.reset + borderFg + "│" + theme.reset,
      );
      continue;
    }

    // Entry row
    const ci = dr.convIdx!;
    const conv = convs[ci];
    const isSelected = ci === sidebar.selectedIndex;
    const isCurrent = conv.id === currentConvId;
    const isPendingDelete = conv.id === sidebar.pendingDeleteId;

    // Streaming/unread indicator
    const streamIcon = conv.streaming ? "◉ " : conv.unread ? "◉ " : "";
    const streamIconColor = conv.streaming ? theme.accent : conv.unread ? theme.success : "";

    const prefix = isSelected ? "▸ " : "  ";
    const markIcon = conv.marked ? "★ " : "";
    const maxTitle = innerWidth - prefix.length - streamIcon.length - markIcon.length;
    let title = conv.title || conv.preview || "(empty)";
    const nlIdx = title.indexOf("\n");
    if (nlIdx !== -1) title = title.slice(0, nlIdx);
    if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + "…";

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : (isSelected || isCurrent) ? theme.text : theme.muted;
    const titleText = isCurrent && !isPendingDelete ? theme.bold + title + theme.boldOff : title;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const markIconColored = markIcon ? theme.warning + markIcon + fg : "";
    const plainLen = prefix.length + streamIcon.length + markIcon.length + title.length;
    const padding = Math.max(0, innerWidth - plainLen);

    rows.push(
      theme.reset + bg + fg +
      prefix + streamIconColored + markIconColored + titleText + " ".repeat(padding) +
      theme.reset + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}
