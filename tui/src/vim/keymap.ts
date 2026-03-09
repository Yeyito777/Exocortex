/**
 * Vim keymap table.
 *
 * The single source of truth for what vim keys do in each mode+context.
 * Adding/changing a binding = one line in this file.
 *
 * Lookup: exact (mode, context, key) first, then wildcard (mode, "*", key).
 * Multi-key sequences ("gg") are stored as their full string.
 */

import type { KeymapEntry, VimCommand, VimMode, VimContext } from "./types";

// ── Keymap ─────────────────────────────────────────────────────────

const KEYMAP: KeymapEntry[] = [

  // ── Normal mode: prompt (full vim editing) ───────────────────────

  // Motions
  { mode: "normal", context: "prompt", key: "h",  command: { type: "motion", name: "char_left" } },
  { mode: "normal", context: "prompt", key: "l",  command: { type: "motion", name: "char_right" } },
  { mode: "normal", context: "prompt", key: "j",  command: { type: "motion", name: "line_down" } },
  { mode: "normal", context: "prompt", key: "k",  command: { type: "motion", name: "line_up" } },
  { mode: "normal", context: "prompt", key: "w",  command: { type: "motion", name: "word_forward" } },
  { mode: "normal", context: "prompt", key: "b",  command: { type: "motion", name: "word_backward" } },
  { mode: "normal", context: "prompt", key: "e",  command: { type: "motion", name: "word_end" } },
  { mode: "normal", context: "prompt", key: "0",  command: { type: "motion", name: "line_start" } },
  { mode: "normal", context: "prompt", key: "$",  command: { type: "motion", name: "line_end" } },
  { mode: "normal", context: "prompt", key: "W",  command: { type: "motion", name: "word_forward_big" } },
  { mode: "normal", context: "prompt", key: "B",  command: { type: "motion", name: "word_backward_big" } },
  { mode: "normal", context: "prompt", key: "E",  command: { type: "motion", name: "word_end_big" } },
  { mode: "normal", context: "prompt", key: "gg", command: { type: "action", action: "scroll_top" } },
  { mode: "normal", context: "prompt", key: "G",  command: { type: "action", action: "scroll_bottom" } },

  // Mode changes
  { mode: "normal", context: "prompt", key: "i",  command: { type: "mode_change", mode: "insert", cursor: "before" } },
  { mode: "normal", context: "prompt", key: "a",  command: { type: "mode_change", mode: "insert", cursor: "after" } },
  { mode: "normal", context: "prompt", key: "I",  command: { type: "mode_change", mode: "insert", cursor: "bol" } },
  { mode: "normal", context: "prompt", key: "A",  command: { type: "mode_change", mode: "insert", cursor: "eol" } },

  // Operators (wait for motion)
  { mode: "normal", context: "prompt", key: "d",  command: { type: "operator", name: "delete" } },
  { mode: "normal", context: "prompt", key: "c",  command: { type: "operator", name: "change" } },
  { mode: "normal", context: "prompt", key: "y",  command: { type: "operator", name: "yank" } },

  // Doubled operators (line operations)
  { mode: "normal", context: "prompt", key: "dd", command: { type: "standalone", name: "delete_line" } },
  { mode: "normal", context: "prompt", key: "cc", command: { type: "standalone", name: "change_line" } },
  { mode: "normal", context: "prompt", key: "yy", command: { type: "standalone", name: "yank_line" } },

  // Undo/redo
  { mode: "normal", context: "prompt", key: "u",  command: { type: "standalone", name: "undo" } },

  // Standalone commands
  { mode: "normal", context: "prompt", key: "x",  command: { type: "standalone", name: "delete_char" } },
  { mode: "normal", context: "prompt", key: "X",  command: { type: "standalone", name: "delete_char_before" } },
  { mode: "normal", context: "prompt", key: "D",  command: { type: "standalone", name: "delete_to_eol" } },
  { mode: "normal", context: "prompt", key: "C",  command: { type: "standalone", name: "change_to_eol" } },
  { mode: "normal", context: "prompt", key: "o",  command: { type: "standalone", name: "open_below" } },
  { mode: "normal", context: "prompt", key: "O",  command: { type: "standalone", name: "open_above" } },
  { mode: "normal", context: "prompt", key: "p",  command: { type: "standalone", name: "paste_after" } },
  { mode: "normal", context: "prompt", key: "P",  command: { type: "standalone", name: "paste_before" } },

  // ── Normal mode: history (cursor navigation) ─────────────────────

  // Motions (same as prompt — move history cursor)
  { mode: "normal", context: "history", key: "h",  command: { type: "action", action: "history_left" } },
  { mode: "normal", context: "history", key: "l",  command: { type: "action", action: "history_right" } },
  { mode: "normal", context: "history", key: "j",  command: { type: "action", action: "history_down" } },
  { mode: "normal", context: "history", key: "k",  command: { type: "action", action: "history_up" } },
  { mode: "normal", context: "history", key: "w",  command: { type: "action", action: "history_w" } },
  { mode: "normal", context: "history", key: "b",  command: { type: "action", action: "history_b" } },
  { mode: "normal", context: "history", key: "e",  command: { type: "action", action: "history_e" } },
  { mode: "normal", context: "history", key: "W",  command: { type: "action", action: "history_W" } },
  { mode: "normal", context: "history", key: "B",  command: { type: "action", action: "history_B" } },
  { mode: "normal", context: "history", key: "E",  command: { type: "action", action: "history_E" } },
  { mode: "normal", context: "history", key: "0",  command: { type: "action", action: "history_0" } },
  { mode: "normal", context: "history", key: "$",  command: { type: "action", action: "history_dollar" } },
  { mode: "normal", context: "history", key: "gg", command: { type: "action", action: "history_gg" } },
  { mode: "normal", context: "history", key: "G",  command: { type: "action", action: "history_G" } },

  // Yank
  { mode: "normal", context: "history", key: "y",  command: { type: "operator", name: "yank" } },
  { mode: "normal", context: "history", key: "yy", command: { type: "action", action: "history_yy" } },

  // Mode changes
  { mode: "normal", context: "history", key: "i",  command: { type: "mode_change", mode: "insert" } },
  { mode: "normal", context: "history", key: "a",  command: { type: "mode_change", mode: "insert" } },

  // ── Normal mode: sidebar ─────────────────────────────────────────

  { mode: "normal", context: "sidebar", key: "j",  command: { type: "action", action: "nav_down" } },
  { mode: "normal", context: "sidebar", key: "k",  command: { type: "action", action: "nav_up" } },
  { mode: "normal", context: "sidebar", key: "gg", command: { type: "action", action: "scroll_top" } },
  { mode: "normal", context: "sidebar", key: "G",  command: { type: "action", action: "scroll_bottom" } },
  { mode: "normal", context: "sidebar", key: "d",  command: { type: "action", action: "delete" } },
  { mode: "normal", context: "sidebar", key: "m",  command: { type: "action", action: "mark" } },
  { mode: "normal", context: "sidebar", key: "p",  command: { type: "action", action: "pin" } },
  { mode: "normal", context: "sidebar", key: "e",  command: { type: "action", action: "move_up" } },
  { mode: "normal", context: "sidebar", key: "E",  command: { type: "action", action: "move_down" } },
  { mode: "normal", context: "sidebar", key: "c",  command: { type: "action", action: "clone" } },
  { mode: "normal", context: "sidebar", key: "u",  command: { type: "action", action: "undo_delete" } },
  { mode: "normal", context: "sidebar", key: "i",  command: { type: "mode_change", mode: "insert" } },
  { mode: "normal", context: "sidebar", key: "a",  command: { type: "mode_change", mode: "insert" } },

  // ── Visual mode: enter from normal ─────────────────────────────
  { mode: "normal", context: "prompt",  key: "v",  command: { type: "mode_change", mode: "visual" } },
  { mode: "normal", context: "prompt",  key: "V",  command: { type: "mode_change", mode: "visual-line" } },
  { mode: "normal", context: "history", key: "v",  command: { type: "mode_change", mode: "visual" } },
  { mode: "normal", context: "history", key: "V",  command: { type: "mode_change", mode: "visual-line" } },

  // ── Visual mode: prompt (motions + operators) ───────────────────
  { mode: "visual", context: "prompt", key: "h",  command: { type: "motion", name: "char_left" } },
  { mode: "visual", context: "prompt", key: "l",  command: { type: "motion", name: "char_right" } },
  { mode: "visual", context: "prompt", key: "j",  command: { type: "motion", name: "line_down" } },
  { mode: "visual", context: "prompt", key: "k",  command: { type: "motion", name: "line_up" } },
  { mode: "visual", context: "prompt", key: "w",  command: { type: "motion", name: "word_forward" } },
  { mode: "visual", context: "prompt", key: "b",  command: { type: "motion", name: "word_backward" } },
  { mode: "visual", context: "prompt", key: "e",  command: { type: "motion", name: "word_end" } },
  { mode: "visual", context: "prompt", key: "W",  command: { type: "motion", name: "word_forward_big" } },
  { mode: "visual", context: "prompt", key: "B",  command: { type: "motion", name: "word_backward_big" } },
  { mode: "visual", context: "prompt", key: "E",  command: { type: "motion", name: "word_end_big" } },
  { mode: "visual", context: "prompt", key: "0",  command: { type: "motion", name: "line_start" } },
  { mode: "visual", context: "prompt", key: "$",  command: { type: "motion", name: "line_end" } },
  { mode: "visual", context: "prompt", key: "gg", command: { type: "motion", name: "buffer_start" } },
  { mode: "visual", context: "prompt", key: "G",  command: { type: "motion", name: "buffer_end" } },
  { mode: "visual", context: "prompt", key: "d",  command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual", context: "prompt", key: "x",  command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual", context: "prompt", key: "c",  command: { type: "standalone", name: "visual_change" } },
  { mode: "visual", context: "prompt", key: "y",  command: { type: "standalone", name: "visual_yank" } },

  // ── Visual mode: history (motions + yank only) ──────────────────
  { mode: "visual", context: "history", key: "h",  command: { type: "action", action: "history_left" } },
  { mode: "visual", context: "history", key: "l",  command: { type: "action", action: "history_right" } },
  { mode: "visual", context: "history", key: "j",  command: { type: "action", action: "history_down" } },
  { mode: "visual", context: "history", key: "k",  command: { type: "action", action: "history_up" } },
  { mode: "visual", context: "history", key: "w",  command: { type: "action", action: "history_w" } },
  { mode: "visual", context: "history", key: "b",  command: { type: "action", action: "history_b" } },
  { mode: "visual", context: "history", key: "e",  command: { type: "action", action: "history_e" } },
  { mode: "visual", context: "history", key: "W",  command: { type: "action", action: "history_W" } },
  { mode: "visual", context: "history", key: "B",  command: { type: "action", action: "history_B" } },
  { mode: "visual", context: "history", key: "E",  command: { type: "action", action: "history_E" } },
  { mode: "visual", context: "history", key: "0",  command: { type: "action", action: "history_0" } },
  { mode: "visual", context: "history", key: "$",  command: { type: "action", action: "history_dollar" } },
  { mode: "visual", context: "history", key: "gg", command: { type: "action", action: "history_gg" } },
  { mode: "visual", context: "history", key: "G",  command: { type: "action", action: "history_G" } },
  { mode: "visual", context: "history", key: "y",  command: { type: "action", action: "history_visual_yank" } },

  // ── Visual-line mode: same as visual but for line selection ─────
  { mode: "visual-line", context: "prompt", key: "j",  command: { type: "motion", name: "line_down" } },
  { mode: "visual-line", context: "prompt", key: "k",  command: { type: "motion", name: "line_up" } },
  { mode: "visual-line", context: "prompt", key: "gg", command: { type: "motion", name: "buffer_start" } },
  { mode: "visual-line", context: "prompt", key: "G",  command: { type: "motion", name: "buffer_end" } },
  { mode: "visual-line", context: "prompt", key: "d",  command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual-line", context: "prompt", key: "x",  command: { type: "standalone", name: "visual_delete" } },
  { mode: "visual-line", context: "prompt", key: "c",  command: { type: "standalone", name: "visual_change" } },
  { mode: "visual-line", context: "prompt", key: "y",  command: { type: "standalone", name: "visual_yank" } },

  { mode: "visual-line", context: "history", key: "j",  command: { type: "action", action: "history_down" } },
  { mode: "visual-line", context: "history", key: "k",  command: { type: "action", action: "history_up" } },
  { mode: "visual-line", context: "history", key: "gg", command: { type: "action", action: "history_gg" } },
  { mode: "visual-line", context: "history", key: "G",  command: { type: "action", action: "history_G" } },
  { mode: "visual-line", context: "history", key: "y",  command: { type: "action", action: "history_visual_yank" } },

  // ── Insert mode: only Esc is captured ────────────────────────────
  // (everything else passes through to existing promptline.ts)
  // Esc is handled directly in the engine, not via keymap.
];

// ── Prefix index (for multi-key sequences) ─────────────────────────

/** Set of all key prefixes in the keymap. Used to detect pending sequences. */
const _prefixes = new Set<string>();
for (const entry of KEYMAP) {
  for (let i = 1; i < entry.key.length; i++) {
    _prefixes.add(`${entry.mode}:${entry.context}:${entry.key.slice(0, i)}`);
    _prefixes.add(`${entry.mode}:*:${entry.key.slice(0, i)}`);
  }
}

// ── Lookup ──────────────────────────────────────────────────────────

/**
 * Look up a command for the given mode, context, and key.
 * Returns the most specific match (exact context > wildcard).
 */
export function lookupCommand(
  mode: VimMode,
  context: VimContext,
  key: string,
): VimCommand | null {
  // Exact match first
  let found: VimCommand | null = null;
  for (const entry of KEYMAP) {
    if (entry.mode === mode && entry.key === key) {
      if (entry.context === context) return entry.command;
      if (entry.context === "*" && !found) found = entry.command;
    }
  }
  return found;
}

/**
 * Check if `key` is a prefix of any keymap entry for the given mode+context.
 * Used to detect that "g" could become "gg" — return pending instead of noop.
 *
 * Returns false if the key already has an exact match for this context —
 * e.g. "d" in sidebar is a complete command, not a prefix of "dd" (prompt-only).
 */
export function isPrefix(mode: VimMode, context: VimContext, key: string): boolean {
  // If there's an exact match for this context, it's not a prefix — it's complete
  if (lookupCommand(mode, context, key)) return false;
  return _prefixes.has(`${mode}:${context}:${key}`) || _prefixes.has(`${mode}:*:${key}`);
}
