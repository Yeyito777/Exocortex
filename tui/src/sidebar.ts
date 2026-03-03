/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
import { theme } from "./theme";

// ── State ───────────────────────────────────────────────────────────

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  selectedIndex: number;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    selectedIndex: 0,
  };
}

// ── Key handling ────────────────────────────────────────────────────

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "unhandled" };

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  switch (key.type) {
    case "char":
      if (key.char === "j" || key.char === "J") {
        sidebar.selectedIndex = Math.min(sidebar.selectedIndex + 1, sidebar.conversations.length - 1);
        return { type: "handled" };
      }
      if (key.char === "k" || key.char === "K") {
        sidebar.selectedIndex = Math.max(sidebar.selectedIndex - 1, 0);
        return { type: "handled" };
      }
      // i or a → switch focus to chat
      if (key.char === "i" || key.char === "a") {
        return { type: "unhandled" };
      }
      return { type: "handled" };

    case "up":
      sidebar.selectedIndex = Math.max(sidebar.selectedIndex - 1, 0);
      return { type: "handled" };

    case "down":
      sidebar.selectedIndex = Math.min(sidebar.selectedIndex + 1, sidebar.conversations.length - 1);
      return { type: "handled" };

    case "enter":
      if (sidebar.conversations.length > 0) {
        return { type: "select", convId: sidebar.conversations[sidebar.selectedIndex].id };
      }
      return { type: "handled" };

    default:
      return { type: "handled" };
  }
}

// ── State updates ───────────────────────────────────────────────────

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[]): void {
  sidebar.conversations = conversations;
  // Clamp selection
  if (sidebar.selectedIndex >= conversations.length) {
    sidebar.selectedIndex = Math.max(0, conversations.length - 1);
  }
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary): void {
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    // New conversation — add to front (sorted by updatedAt desc)
    sidebar.conversations.unshift(summary);
  }
  // Re-sort
  sidebar.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Rendering ───────────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 30;

export function renderSidebar(
  sidebar: SidebarState,
  rows: number,
  focused: boolean,
): string[] {
  const lines: string[] = [];
  const w = SIDEBAR_WIDTH;

  // Title row
  const titleText = " Conversations";
  const titlePad = " ".repeat(Math.max(0, w - titleText.length));
  lines.push(`${theme.topbarBg}${theme.bold}${titleText}${theme.reset}${theme.topbarBg}${titlePad}${theme.reset}`);

  // Separator
  const sepColor = focused ? theme.accent : theme.dim;
  lines.push(`${sepColor}${"─".repeat(w)}${theme.reset}`);

  // Conversation list
  const listHeight = rows - 2; // minus title + separator
  const convs = sidebar.conversations;

  // Scroll to keep selection visible
  let scrollStart = 0;
  if (sidebar.selectedIndex >= listHeight) {
    scrollStart = sidebar.selectedIndex - listHeight + 1;
  }

  for (let i = 0; i < listHeight; i++) {
    const ci = scrollStart + i;
    if (ci >= convs.length) {
      lines.push(" ".repeat(w));
      continue;
    }

    const conv = convs[ci];
    const isSelected = ci === sidebar.selectedIndex;
    const prefix = isSelected ? (focused ? `${theme.accent}▸ ` : `${theme.muted}▸ `) : "  ";
    const preview = conv.preview || "(empty)";
    const truncated = preview.length > w - 4 ? preview.slice(0, w - 7) + "..." : preview;
    const padLen = Math.max(0, w - truncated.length - 2);

    if (isSelected) {
      lines.push(`${prefix}${theme.text}${truncated}${" ".repeat(padLen)}${theme.reset}`);
    } else {
      lines.push(`${prefix}${theme.muted}${truncated}${" ".repeat(padLen)}${theme.reset}`);
    }
  }

  return lines;
}
