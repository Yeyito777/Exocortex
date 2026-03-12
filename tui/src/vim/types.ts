/**
 * Vim system types.
 *
 * Core type definitions for the vim engine.
 * No runtime logic — pure type declarations.
 */

import type { Action } from "../keybinds";

// ── Mode ───────────────────────────────────────────────────────────

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

// ── Context ────────────────────────────────────────────────────────

/** Maps to the TUI's focus state. */
export type VimContext = "prompt" | "history" | "sidebar";

// ── State ──────────────────────────────────────────────────────────

export interface VimState {
  mode: VimMode;
  /** Pending operator waiting for a motion/textobject ("d", "c", "y"). */
  pendingOperator: string | null;
  pendingOperatorKey: string | null;
  /** Text object modifier ("i" or "a") waiting for specifier key.
   *  Set after an operator in normal mode, or standalone in visual mode. */
  pendingTextObjectModifier: "i" | "a" | null;
  /** Accumulated multi-key prefix ("g" waiting for "g" → "gg"). */
  pendingKeys: string;
  /** Numeric prefix (e.g. 3 in "3w"). Null = 1. */
  count: number | null;
  /** Anchor position for visual mode selection. */
  visualAnchor: number;
  /** Waiting for a character after f/F/t/T. */
  pendingFind: "f" | "F" | null;
  /** Last f/F find — used by ; and , to repeat. */
  lastFind: { char: string; direction: "f" | "F" } | null;
}

export function createVimState(): VimState {
  return {
    mode: "insert",
    pendingOperator: null,
    pendingOperatorKey: null,
    pendingTextObjectModifier: null,
    pendingKeys: "",
    count: null,
    visualAnchor: 0,
    pendingFind: null,
    lastFind: null,
  };
}

/** Reset all pending state (count, operator, keys, text object modifier, pending find). */
export function resetPending(vim: VimState): void {
  vim.pendingOperator = null;
  vim.pendingOperatorKey = null;
  vim.pendingTextObjectModifier = null;
  vim.pendingKeys = "";
  vim.count = null;
  vim.pendingFind = null;
  // lastFind is intentionally NOT cleared — ; and , need it across commands
}

// ── Result ─────────────────────────────────────────────────────────

/**
 * What the vim engine returns after processing a key.
 * The caller (focus.ts) decides what to do with each variant.
 */
export type VimResult =
  /** Maps to an existing Action — dispatch through normal system. */
  | { type: "action"; action: Action }
  /** Buffer was edited (operator applied). Caller updates state. */
  | { type: "buffer_edit"; buffer: string; cursor: number; mode?: VimMode }
  /** Cursor moved (motion executed). Caller updates cursorPos. */
  | { type: "cursor_move"; cursor: number }
  /** Mode changed. Optional cursor adjustment (e.g. Esc moves cursor left). */
  | { type: "mode_change"; mode: VimMode; cursor?: number }
  /** Text was yanked — caller copies to clipboard. Cursor stays put. */
  | { type: "yank"; text: string }
  /** Paste requested — caller reads clipboard, inserts at position. */
  | { type: "paste"; position: "after" | "before" }
  /** Visual selection deleted/changed in prompt. */
  | { type: "visual_edit"; buffer: string; cursor: number; mode: VimMode }
  /** Undo/redo requested — caller manages the stack. */
  | { type: "undo" }
  | { type: "redo" }
  /** Engine consumed the key but needs more input (e.g. "d" waiting for motion). */
  | { type: "pending" }
  /** Engine doesn't handle this key — fall through to existing system. */
  | { type: "passthrough" }
  /** Invalid sequence — key consumed, nothing happens. */
  | { type: "noop" };

// ── Range ──────────────────────────────────────────────────────────

/** An inclusive range in the buffer. */
export interface Range {
  start: number;
  end: number;
}

// ── Buffer edit result ─────────────────────────────────────────────

export interface BufferEdit {
  buffer: string;
  cursor: number;
}

// ── Keymap command types ───────────────────────────────────────────

export type VimCommand =
  | { type: "motion"; name: string }
  | { type: "operator"; name: string }
  | { type: "mode_change"; mode: VimMode; cursor?: "before" | "after" | "bol" | "eol" }
  | { type: "action"; action: Action }
  | { type: "standalone"; name: string }
  | { type: "noop" };

// ── Keymap entry ───────────────────────────────────────────────────

export interface KeymapEntry {
  mode: VimMode;
  context: VimContext | "*";
  key: string;
  command: VimCommand;
}

// ── Key string conversion ─────────────────────────────────────────

import type { KeyEvent } from "../input";

/** Convert a KeyEvent to the key string used in the keymap. */
export function keyString(key: KeyEvent): string | null {
  if (key.type === "char" && key.char) return key.char;
  if (key.type === "escape") return "escape";
  if (key.type === "enter") return "enter";
  return null;
}
