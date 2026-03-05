/**
 * Vim system types.
 *
 * Core type definitions for the vim engine.
 * No runtime logic — pure type declarations.
 */

import type { Action } from "../keybinds";

// ── Mode ───────────────────────────────────────────────────────────

export type VimMode = "normal" | "insert" | "visual";

// ── Context ────────────────────────────────────────────────────────

/** Maps to the TUI's focus state. */
export type VimContext = "prompt" | "history" | "sidebar";

// ── State ──────────────────────────────────────────────────────────

export interface VimState {
  mode: VimMode;
  /** Pending operator waiting for a motion/textobject ("d", "c", "y"). */
  pendingOperator: string | null;
  pendingOperatorKey: string | null;
  /** Text object modifier ("i" or "a") after an operator, waiting for specifier. */
  pendingTextObjectModifier: "i" | "a" | null;
  /** Accumulated multi-key prefix ("g" waiting for "g" → "gg"). */
  pendingKeys: string;
  /** Numeric prefix (e.g. 3 in "3w"). Null = 1. */
  count: number | null;
}

export function createVimState(): VimState {
  return {
    mode: "insert",
    pendingOperator: null,
    pendingOperatorKey: null,
    pendingTextObjectModifier: null,
    pendingKeys: "",
    count: null,
  };
}

/** Reset all pending state (count, operator, keys, text object modifier). */
export function resetPending(vim: VimState): void {
  vim.pendingOperator = null;
  vim.pendingOperatorKey = null;
  vim.pendingTextObjectModifier = null;
  vim.pendingKeys = "";
  vim.count = null;
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
