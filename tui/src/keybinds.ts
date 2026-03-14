/**
 * Keybind definitions.
 *
 * Maps raw key events to semantic actions. The single source of truth
 * for all keybindings in the TUI. Every handler checks action names,
 * never raw key types.
 *
 * To change a keybind: edit this file. One line, one place.
 * Future: load from user config to make keybinds customizable.
 */

import type { KeyEvent } from "./input";

// ── Actions ─────────────────────────────────────────────────────────

export type Action =
  // Global
  | "quit"
  | "abort"
  | "sidebar_toggle"
  | "focus_cycle"
  | "paste_image"
  // Chat / focus
  | "focus_prompt"
  | "focus_history"
  // Prompt editing
  | "submit"
  | "newline"
  | "delete_back"
  | "delete_forward"
  | "cursor_left"
  | "cursor_right"
  | "cursor_up"
  | "cursor_down"
  | "cursor_home"
  | "cursor_end"
  // Navigation (sidebar, history scroll)
  | "nav_up"
  | "nav_down"
  | "nav_select"
  | "delete"
  | "mark"
  | "pin"
  | "move_up"
  | "move_down"
  | "clone"
  | "undo_delete"
  // Scrolling
  | "scroll_line_up"
  | "scroll_line_down"
  | "scroll_half_up"
  | "scroll_half_down"
  | "scroll_page_up"
  | "scroll_page_down"
  | "scroll_top"
  | "scroll_bottom"
  // Conversation
  | "new_conversation"
  | "edit_message"
  // Display toggles
  | "toggle_tool_output"
  // Sidebar navigation (from any panel)
  | "sidebar_next"
  | "sidebar_prev"
  // Streaming navigation
  | "nav_prev_streaming"
  | "nav_next_streaming"
  // History cursor motions
  | "history_left"
  | "history_right"
  | "history_up"
  | "history_down"
  | "history_w"
  | "history_b"
  | "history_e"
  | "history_W"
  | "history_B"
  | "history_E"
  | "history_0"
  | "history_dollar"
  | "history_gg"
  | "history_G"
  | "history_yy"
  | "history_visual_yank";

// ── Keybind map ─────────────────────────────────────────────────────

/** Key type → action. For "char" keys, use char:<char> format. */
const BINDS: Record<string, Action> = {
  // Global
  "ctrl-c":     "quit",
  "ctrl-q":     "abort",
  "ctrl-m":     "sidebar_toggle",
  "ctrl-j":     "focus_cycle",
  "ctrl-k":     "focus_cycle",

  // Chat focus switching
  "ctrl-n":     "focus_history",

  // Conversation
  "ctrl-shift-o": "new_conversation",

  // Clipboard image paste
  "ctrl-v":       "paste_image",

  // Display toggles
  "ctrl-o":       "toggle_tool_output",

  // Sidebar quick nav (Shift+J/K from any panel)
  "char:J":     "sidebar_next",
  "char:K":     "sidebar_prev",

  // Conversation editing
  "ctrl-w":     "edit_message",

  // Scrolling
  "ctrl-y":     "scroll_line_up",
  "ctrl-e":     "scroll_line_down",
  "ctrl-u":     "scroll_half_up",
  "ctrl-d":     "scroll_half_down",
  "ctrl-b":     "scroll_page_up",
  "ctrl-f":     "scroll_page_down",

  // Prompt editing
  "enter":      "submit",
  "ctrl-l":     "newline",
  "backspace":  "delete_back",
  "delete":     "delete_forward",
  "left":       "cursor_left",
  "right":      "cursor_right",
  "up":         "cursor_up",
  "down":       "cursor_down",
  "home":       "cursor_home",
  "end":        "cursor_end",

};

/**
 * Context-specific bindings — only active outside the prompt.
 * These keys are regular chars when typing, but navigation
 * actions in sidebar/history contexts.
 */
const NAV_BINDS: Record<string, Action> = {
  "char:j":     "nav_down",
  "char:k":     "nav_up",
  "char:i":     "focus_prompt",
  "char:a":     "focus_prompt",
  "char:d":     "delete",
  "char:D":     "delete",
  "char:e":     "move_up",
  "char:E":     "move_down",
  "char:c":     "clone",
  "char:u":     "undo_delete",
  "char:{":     "nav_prev_streaming",
  "char:}":     "nav_next_streaming",
};

// ── Context ─────────────────────────────────────────────────────────

export type KeyContext = "prompt" | "navigation";

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve a key event to a semantic action.
 * Returns null if the key has no binding.
 *
 * context = "navigation" enables j/k/i/a bindings (sidebar, history).
 * context = "prompt" (default) keeps those as regular character input.
 */
export function resolveAction(key: KeyEvent, context: KeyContext = "prompt"): Action | null {
  // Check char-specific bindings
  if (key.type === "char" && key.char) {
    // Navigation-context bindings (j/k/i/a)
    if (context === "navigation") {
      const navAction = NAV_BINDS[`char:${key.char}`];
      if (navAction) return navAction;
    }

    // Global char bindings
    const charAction = BINDS[`char:${key.char}`];
    if (charAction) return charAction;
  }

  // Check type-level bindings
  return BINDS[key.type] ?? null;
}
