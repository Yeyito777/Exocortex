/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
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

    case "focus_prompt":
      return { type: "unhandled" };

    default:
      return { type: "handled" };
  }
}

function moveSelection(sidebar: SidebarState, delta: number): void {
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
  sidebar.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
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
  // selectedId not found — clamp index
  sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, sidebar.conversations.length - 1));
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

  // Remaining rows: conversation list
  const listRows = totalRows - 2;
  const convs = sidebar.conversations;

  // Scroll to keep selection visible
  let scrollOffset = sidebar.scrollOffset;
  if (sidebar.selectedIndex < scrollOffset) {
    scrollOffset = sidebar.selectedIndex;
  } else if (sidebar.selectedIndex >= scrollOffset + listRows) {
    scrollOffset = sidebar.selectedIndex - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, convs.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const ci = scrollOffset + i;

    if (ci >= convs.length) {
      // Empty row
      rows.push(
        theme.sidebarBg +
        " ".repeat(innerWidth) +
        theme.reset + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const conv = convs[ci];
    const isSelected = ci === sidebar.selectedIndex;
    const isCurrent = conv.id === currentConvId;
    const isPendingDelete = conv.id === sidebar.pendingDeleteId;

    // Build entry
    const prefix = isSelected ? "▸ " : "  ";
    const maxTitle = innerWidth - prefix.length;
    let title = conv.preview || "(empty)";
    // Take first line only
    const nlIdx = title.indexOf("\n");
    if (nlIdx !== -1) title = title.slice(0, nlIdx);
    if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + "…";

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : (isSelected || isCurrent) ? theme.text : theme.muted;
    const titleText = isCurrent && !isPendingDelete ? theme.bold + title + theme.boldOff : title;
    const plainLen = prefix.length + title.length;
    const padding = Math.max(0, innerWidth - plainLen);

    rows.push(
      theme.reset + bg + fg +
      prefix + titleText + " ".repeat(padding) +
      theme.reset + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}
