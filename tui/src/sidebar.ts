/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
import { sortConversations, convDisplayName, bottomPinnedOrder, topUnpinnedOrder } from "./messages";
import { resolveAction } from "./keybinds";
import { theme } from "./theme";
import { getMarkFromTitle, stripMark, toggleMark } from "./marks";

// ── Constants ───────────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 28;

// ── State ───────────────────────────────────────────────────────────

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  previousEnteredId: string | null;
  selectedIndex: number;
  scrollOffset: number;
  pendingDeleteId: string | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    selectedId: null,
    previousEnteredId: null,
    selectedIndex: 0,
    scrollOffset: 0,
    pendingDeleteId: null,
  };
}

// ── Selection helpers ───────────────────────────────────────────────

export function focusConversationAt(sidebar: SidebarState, index: number): void {
  if (sidebar.conversations.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.selectedId = null;
    return;
  }

  const nextIndex = Math.max(0, Math.min(index, sidebar.conversations.length - 1));
  const nextId = sidebar.conversations[nextIndex]?.id ?? null;
  sidebar.selectedIndex = nextIndex;
  sidebar.selectedId = nextId;
}

export function focusConversationById(sidebar: SidebarState, convId: string): boolean {
  const idx = sidebar.conversations.findIndex(c => c.id === convId);
  if (idx === -1) return false;
  focusConversationAt(sidebar, idx);
  return true;
}

/** Remember the last conversation the user actually entered/loaded. */
export function rememberEnteredConversation(
  sidebar: SidebarState,
  currentConvId: string | null,
  nextConvId: string | null,
): void {
  if (currentConvId && currentConvId !== nextConvId) {
    sidebar.previousEnteredId = currentConvId;
  }
}

export function focusPreviousEnteredConversation(sidebar: SidebarState): boolean {
  if (!sidebar.previousEnteredId) return false;
  return focusConversationById(sidebar, sidebar.previousEnteredId);
}

// ── Key handling ────────────────────────────────────────────────────

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
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
        // Focus the next conversation (now at the same index after splice),
        // clamping to the last item when deleting the tail entry.
        focusConversationAt(sidebar, sidebar.selectedIndex);
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
      // Compute the sortOrder the daemon will assign so the optimistic
      // sort matches the authoritative order and avoids a visible snap.
      conv.sortOrder = newPinned
        ? bottomPinnedOrder(sidebar.conversations, conv.id)
        : topUnpinnedOrder(sidebar.conversations, conv.id);
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
      // If sortOrders were equal the swap is a no-op — differentiate them
      if (conv.sortOrder === target.sortOrder) {
        if (direction === "up") {
          conv.sortOrder -= 0.5;
        } else {
          conv.sortOrder += 0.5;
        }
      }
      // Follow the moved item
      focusConversationAt(sidebar, targetIdx);
      return { type: "move_conversation", convId: conv.id, direction };
    }

    case "nav_next_streaming":
      moveToStreaming(sidebar, 1);
      return { type: "handled" };

    case "nav_prev_streaming":
      moveToStreaming(sidebar, -1);
      return { type: "handled" };

    case "focus_prompt":
      return { type: "unhandled" };

    default:
      return { type: "handled" };
  }
}

export function moveSelection(sidebar: SidebarState, delta: number): void {
  focusConversationAt(sidebar, sidebar.selectedIndex + delta);
}

/** Jump to the next (delta=1) or previous (delta=-1) conversation with a streaming indicator, wrapping around. */
function moveToStreaming(sidebar: SidebarState, delta: 1 | -1): void {
  const len = sidebar.conversations.length;
  if (len === 0) return;
  for (let step = 1; step < len; step++) {
    const idx = ((sidebar.selectedIndex + delta * step) % len + len) % len;
    const conv = sidebar.conversations[idx];
    if (conv.streaming || conv.unread) {
      focusConversationAt(sidebar, idx);
      return;
    }
  }
}

// ── Emoji marks ────────────────────────────────────────────────────

/**
 * Toggle an emoji mark on the selected conversation.
 * key 1-9 sets (or toggles off) the corresponding mark.
 * key 0 clears any mark.
 */
export function handleSidebarMark(sidebar: SidebarState, key: number): SidebarKeyResult {
  if (sidebar.conversations.length === 0) return { type: "handled" };
  const conv = sidebar.conversations[sidebar.selectedIndex];
  if (!conv) return { type: "handled" };

  const newTitle = toggleMark(conv.title, key);
  if (newTitle === conv.title) return { type: "handled" };

  // Optimistic update
  conv.title = newTitle;
  return { type: "rename_conversation", convId: conv.id, title: newTitle };
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
    focusConversationAt(sidebar, firstUnpinned);
  } else {
    // All pinned (or empty) — fall back to clamped index
    focusConversationAt(sidebar, sidebar.selectedIndex);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Pad or truncate a string to exactly `width` visible characters. */
function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

// ── Display row layout ─────────────────────────────────────────────

interface DisplayRow {
  type: "label" | "delimiter" | "entry";
  convIdx?: number;
  text?: string;
}

/**
 * Build the flat list of display rows from the conversation list.
 * Used by both rendering and mouse hit-testing so the layout is
 * defined in one place.
 */
function buildDisplayRows(convs: ConversationSummary[]): DisplayRow[] {
  const pinnedCount = convs.filter(c => c.pinned).length;
  const rows: DisplayRow[] = [];

  if (pinnedCount > 0) {
    rows.push({ type: "label", text: " Pinned" });
    for (let i = 0; i < pinnedCount; i++) {
      rows.push({ type: "entry", convIdx: i });
    }
    rows.push({ type: "delimiter" });
  }
  for (let i = pinnedCount; i < convs.length; i++) {
    rows.push({ type: "entry", convIdx: i });
  }

  return rows;
}

// ── Mouse support ──────────────────────────────────────────────────

/**
 * Hit-test a screen row click to find which conversation index was clicked.
 * Returns the convs[] index, or null if the click was on a non-entry row
 * (header, separator, label, delimiter, or out of bounds).
 *
 * @param screenRow 1-based screen row
 * @param sidebar current sidebar state
 */
export function sidebarHitTest(screenRow: number, sidebar: SidebarState): number | null {
  // Rows 1-2 are header and separator — not clickable
  if (screenRow <= 2) return null;

  const displayRows = buildDisplayRows(sidebar.conversations);

  // Screen row 3 = display row at scrollOffset
  const displayIdx = (screenRow - 3) + sidebar.scrollOffset;
  if (displayIdx < 0 || displayIdx >= displayRows.length) return null;

  const dr = displayRows[displayIdx];
  if (dr.type !== "entry") return null;
  return dr.convIdx!;
}

/** Scroll the sidebar list by a number of entries (positive = down, negative = up). */
export function scrollSidebar(sidebar: SidebarState, delta: number): void {
  const maxOffset = Math.max(0, sidebar.conversations.length - 1);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset + delta, maxOffset));
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
  const borderBg = theme.appBg ?? '';

  // Row 1: header
  const header = " Conversations";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold +
    pad(header, innerWidth) +
    theme.reset + borderBg + borderFg + "│" + theme.reset,
  );

  // Row 2: separator with ┤ junction
  rows.push(
    theme.sidebarBg + borderFg +
    "─".repeat(innerWidth) + borderBg + "┤" + theme.reset,
  );

  // Build display rows: section labels + delimiter + conversation entries
  const convs = sidebar.conversations;
  const displayRows = buildDisplayRows(convs);

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
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const dr = displayRows[di];

    if (dr.type === "label") {
      rows.push(
        theme.sidebarBg + theme.text + theme.bold +
        pad(dr.text!, innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    if (dr.type === "delimiter") {
      rows.push(
        theme.sidebarBg + theme.muted +
        pad(" " + "─".repeat(innerWidth - 2) + " ", innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
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

    // Star (★) from the boolean `marked` flag — independent of emoji marks
    const starIcon = conv.marked ? "★ " : "";
    const starIconWidth = conv.marked ? 2 : 0;

    // Emoji mark: extracted from title prefix (e.g. "🕐 my convo" → "🕐")
    const mark = getMarkFromTitle(conv.title);
    const emojiIcon = mark ? mark.emoji + " " : "";
    // Terminal width: emoji = 2 cols + space = 1 col
    const emojiIconWidth = mark ? mark.width + 1 : 0;

    const iconsWidth = starIconWidth + emojiIconWidth;
    const maxTitle = innerWidth - prefix.length - streamIcon.length - iconsWidth;
    // Strip the emoji prefix from the display name (it's rendered separately)
    let title = convDisplayName(conv, "(empty)");
    if (mark) title = stripMark(title);
    if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + "…";

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : (isSelected || isCurrent) ? theme.text : theme.muted;
    const titleText = isCurrent && !isPendingDelete ? theme.bold + title + theme.boldOff : title;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";
    const plainLen = prefix.length + streamIcon.length + iconsWidth + title.length;
    const padding = Math.max(0, innerWidth - plainLen);

    rows.push(
      theme.reset + bg + fg +
      prefix + streamIconColored + starIconColored + emojiIconColored + titleText + " ".repeat(padding) +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}
