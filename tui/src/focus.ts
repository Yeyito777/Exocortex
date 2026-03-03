/**
 * Panel-level focus routing.
 *
 * Routes key events based on which panel has focus (sidebar or chat).
 * Chat manages its own inner focus (prompt/history) via chat.ts.
 * Sidebar manages its own keys via sidebar.ts.
 *
 * This is the top-level key routing — the only file main.ts calls
 * for key handling.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { handleChatKey } from "./chat";
import { handleSidebarKey } from "./sidebar";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  // Global keys — work regardless of focus
  switch (key.type) {
    case "ctrl-c":
    case "ctrl-d":
      return { type: "quit" };
    case "escape":
      return { type: "abort" };
    case "ctrl-b":
      // Toggle sidebar open/close + focus
      state.sidebar.open = !state.sidebar.open;
      state.panelFocus = state.sidebar.open ? "sidebar" : "chat";
      return { type: "handled" };
    case "ctrl-k":
      // Cycle focus: sidebar ↔ chat (only if sidebar is open)
      if (state.sidebar.open) {
        state.panelFocus = state.panelFocus === "sidebar" ? "chat" : "sidebar";
      }
      return { type: "handled" };
  }

  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    return handleSidebarFocused(key, state);
  } else {
    return handleChatFocused(key, state);
  }
}

// ── Sidebar panel ───────────────────────────────────────────────────

function handleSidebarFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleSidebarKey(key, state.sidebar);

  switch (result.type) {
    case "handled":
      return { type: "handled" };
    case "select":
      return { type: "load_conversation", convId: result.convId };
    case "unhandled":
      // i/a in sidebar → switch to chat
      if (key.type === "char" && (key.char === "i" || key.char === "a")) {
        state.panelFocus = "chat";
        return { type: "handled" };
      }
      return { type: "handled" };
  }
}

// ── Chat panel ──────────────────────────────────────────────────────

function handleChatFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleChatKey(key, state);

  switch (result.type) {
    case "submit":
      return { type: "submit" };
    case "handled":
      return { type: "handled" };
    case "unhandled":
      return { type: "handled" };
  }
}
