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
  { mode: "normal", context: "prompt", key: "gg", command: { type: "motion", name: "buffer_start" } },
  { mode: "normal", context: "prompt", key: "G",  command: { type: "motion", name: "buffer_end" } },

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

  // Standalone commands
  { mode: "normal", context: "prompt", key: "x",  command: { type: "standalone", name: "delete_char" } },
  { mode: "normal", context: "prompt", key: "X",  command: { type: "standalone", name: "delete_char_before" } },
  { mode: "normal", context: "prompt", key: "D",  command: { type: "standalone", name: "delete_to_eol" } },
  { mode: "normal", context: "prompt", key: "C",  command: { type: "standalone", name: "change_to_eol" } },
  { mode: "normal", context: "prompt", key: "o",  command: { type: "standalone", name: "open_below" } },
  { mode: "normal", context: "prompt", key: "O",  command: { type: "standalone", name: "open_above" } },
  { mode: "normal", context: "prompt", key: "p",  command: { type: "standalone", name: "paste_after" } },
  { mode: "normal", context: "prompt", key: "P",  command: { type: "standalone", name: "paste_before" } },

  // ── Normal mode: history ─────────────────────────────────────────

  { mode: "normal", context: "history", key: "j",  command: { type: "action", action: "nav_down" } },
  { mode: "normal", context: "history", key: "k",  command: { type: "action", action: "nav_up" } },
  { mode: "normal", context: "history", key: "gg", command: { type: "action", action: "nav_up" } },  // TODO: scroll_top
  { mode: "normal", context: "history", key: "G",  command: { type: "action", action: "nav_down" } },  // TODO: scroll_bottom
  { mode: "normal", context: "history", key: "i",  command: { type: "mode_change", mode: "insert" } },
  { mode: "normal", context: "history", key: "a",  command: { type: "mode_change", mode: "insert" } },

  // ── Normal mode: sidebar ─────────────────────────────────────────

  { mode: "normal", context: "sidebar", key: "j",  command: { type: "action", action: "nav_down" } },
  { mode: "normal", context: "sidebar", key: "k",  command: { type: "action", action: "nav_up" } },
  { mode: "normal", context: "sidebar", key: "gg", command: { type: "action", action: "nav_up" } },  // TODO: scroll_top
  { mode: "normal", context: "sidebar", key: "G",  command: { type: "action", action: "nav_down" } },  // TODO: scroll_bottom
  { mode: "normal", context: "sidebar", key: "d",  command: { type: "action", action: "delete" } },
  { mode: "normal", context: "sidebar", key: "i",  command: { type: "mode_change", mode: "insert" } },
  { mode: "normal", context: "sidebar", key: "a",  command: { type: "mode_change", mode: "insert" } },

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
 */
export function isPrefix(mode: VimMode, context: VimContext, key: string): boolean {
  return _prefixes.has(`${mode}:${context}:${key}`) || _prefixes.has(`${mode}:*:${key}`);
}
