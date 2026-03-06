/**
 * Vim engine — the state machine.
 *
 * Processes one key at a time. Maintains mode, pending operator,
 * multi-key sequences, and count prefix. Returns a VimResult
 * telling the caller what happened.
 *
 * The engine mutates VimState (mode, pending) and returns results.
 * It does NOT mutate the buffer or cursor — that's the caller's job.
 */

import type { KeyEvent } from "../input";
import type {
  VimState, VimResult, VimContext, VimMode, VimCommand, BufferEdit,
} from "./types";
import { resetPending, keyString } from "./types";
import { lookupCommand, isPrefix } from "./keymap";
import { resolveMotion, findForward, findBackward } from "./motions";
import { resolveTextObject, isTextObjectKey } from "./textobjects";
import { lineStartOf, lineEndOf, clampNormal } from "./buffer";
import * as ops from "./operators";
import { handleVisualMode } from "./visual";

// ── Process key ────────────────────────────────────────────────────

export function processKey(
  key: KeyEvent,
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  // ── Insert mode ────────────────────────────────────────────────
  if (vim.mode === "insert") {
    return handleInsertMode(key, vim, buffer, cursor);
  }

  // ── Visual / Visual-line mode ──────────────────────────────────
  if (vim.mode === "visual" || vim.mode === "visual-line") {
    return handleVisualMode(key, vim, context, buffer, cursor);
  }

  // ── Normal mode ────────────────────────────────────────────────
  return handleNormalMode(key, vim, context, buffer, cursor);
}

// ── Insert mode handling ───────────────────────────────────────────

function handleInsertMode(key: KeyEvent, vim: VimState, buffer: string, cursor: number): VimResult {
  if (key.type === "escape") {
    vim.mode = "normal";
    resetPending(vim);
    // Vim convention: cursor moves left on Esc, but never across \n
    let newCursor = cursor;
    if (newCursor > 0 && buffer[newCursor - 1] !== "\n") {
      newCursor--;
    }
    newCursor = clampNormal(buffer, newCursor);
    return { type: "mode_change", mode: "normal", cursor: newCursor };
  }
  // Everything else passes through to promptline / existing system
  return { type: "passthrough" };
}

// ── Find helpers ──────────────────────────────────────────────────

/** Resolve a find motion (f/F) to a new cursor position. */
function resolveFind(dir: "f" | "F", char: string, buffer: string, pos: number): number {
  return dir === "f" ? findForward(buffer, pos, char) : findBackward(buffer, pos, char);
}

/** Apply a find as a standalone motion. Only stores lastFind when storeFind is true (f/F, not ;/,). */
function applyFindMotion(vim: VimState, dir: "f" | "F", char: string, buffer: string, cursor: number, storeFind: boolean): VimResult {
  if (storeFind) vim.lastFind = { char, direction: dir };
  vim.pendingFind = null;
  const newPos = resolveFind(dir, char, buffer, cursor);
  return { type: "cursor_move", cursor: newPos };
}

/** Apply a find with a pending operator. Only stores lastFind when storeFind is true. */
function applyFindOperator(vim: VimState, dir: "f" | "F", char: string, buffer: string, cursor: number, storeFind: boolean): VimResult {
  if (storeFind) vim.lastFind = { char, direction: dir };
  vim.pendingFind = null;
  const target = resolveFind(dir, char, buffer, cursor);
  if (target === cursor) { resetPending(vim); return { type: "noop" }; }
  // f is inclusive — include the found character in the range
  const start = Math.min(cursor, target);
  const end = Math.max(cursor, target);
  const result = applyOperatorToRange(vim.pendingOperator!, buffer, start, end);
  resetPending(vim);
  return result;
}

// ── Normal mode handling ───────────────────────────────────────────

function handleNormalMode(
  key: KeyEvent,
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  const ks = keyString(key);

  // Ctrl+R in prompt normal mode → redo
  if (key.type === "ctrl-r" && context === "prompt") {
    resetPending(vim);
    return { type: "redo" };
  }

  // Special keys (ctrl, arrows, etc.) pass through to existing system
  if (ks === null) return { type: "passthrough" };

  // Escape in normal mode passes through (abort, etc.)
  if (ks === "escape") {
    resetPending(vim);
    return { type: "passthrough" };
  }

  // Enter always passes through (submit)
  if (ks === "enter") {
    resetPending(vim);
    return { type: "passthrough" };
  }

  // ── Pending find (f/F waiting for character) ────────────────────
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { vim.pendingFind = null; return { type: "noop" }; }
    if (vim.pendingOperator) {
      return applyFindOperator(vim, vim.pendingFind, key.char, buffer, cursor, true);
    }
    return applyFindMotion(vim, vim.pendingFind, key.char, buffer, cursor, true);
  }

  // ── Count prefix ───────────────────────────────────────────────
  // Digits 1-9 start a count, 0 only continues (0 alone is line_start motion)
  if (/^[1-9]$/.test(ks) || (ks === "0" && vim.count !== null)) {
    vim.count = (vim.count ?? 0) * 10 + parseInt(ks, 10);
    return { type: "pending" };
  }

  // ── f/F — initiate find; ;/, — repeat last find ────────────────
  if (ks === "f" || ks === "F") {
    vim.pendingFind = ks;
    return { type: "pending" };
  }
  if (ks === ";" || ks === ",") {
    if (!vim.lastFind) return { type: "noop" };
    const dir = ks === ";" ? vim.lastFind.direction
      : (vim.lastFind.direction === "f" ? "F" : "f") as "f" | "F";
    if (vim.pendingOperator) {
      return applyFindOperator(vim, dir, vim.lastFind.char, buffer, cursor, false);
    }
    return applyFindMotion(vim, dir, vim.lastFind.char, buffer, cursor, false);
  }

  // ── Build full key (pending multi-key + current) ───────────────
  const fullKey = vim.pendingKeys + ks;

  // ── Check keymap for doubled operator (dd, cc, yy) ─────────────
  if (vim.pendingOperator && ks === vim.pendingOperatorKey) {
    const doubled = vim.pendingOperatorKey + ks;
    const cmd = lookupCommand(vim.mode, context, doubled);
    if (cmd) {
      const result = executeCommand(cmd, vim, context, buffer, cursor);
      resetPending(vim);
      return result;
    }
  }

  // ── Pending text object modifier (operator + i/a + ???) ─────────
  if (vim.pendingOperator && vim.pendingTextObjectModifier) {
    if (isTextObjectKey(ks)) {
      const result = executeOperatorTextObject(
        vim.pendingOperator, vim.pendingTextObjectModifier, ks, vim, buffer, cursor,
      );
      resetPending(vim);
      return result;
    }
    // Not a valid text object specifier — cancel
    resetPending(vim);
    return { type: "noop" };
  }

  // ── Pending operator + motion or text object modifier ──────────
  if (vim.pendingOperator) {
    // "i" or "a" after operator → text object modifier
    if (ks === "i" || ks === "a") {
      vim.pendingTextObjectModifier = ks;
      return { type: "pending" };
    }

    // f/F after operator — handled above
    const cmd = lookupCommand(vim.mode, context, ks);
    if (cmd && cmd.type === "motion") {
      const result = executeOperatorMotion(vim.pendingOperator, cmd.name, vim, buffer, cursor);
      resetPending(vim);
      return result;
    }
    // Not a valid motion after operator — cancel
    resetPending(vim);
    return { type: "noop" };
  }

  // ── Multi-key sequence check ───────────────────────────────────
  const cmd = lookupCommand(vim.mode, context, fullKey);
  if (cmd) {
    vim.pendingKeys = "";
    const result = executeCommand(cmd, vim, context, buffer, cursor);
    // If this set a pending operator, record the raw key for doubled check (dd, cc, yy)
    if (cmd.type === "operator") vim.pendingOperatorKey = ks;
    return result;
  }

  // Maybe a prefix of a longer sequence (e.g. "g" → "gg")
  if (isPrefix(vim.mode, context, fullKey)) {
    vim.pendingKeys = fullKey;
    return { type: "pending" };
  }

  // ── Unrecognized key ───────────────────────────────────────────
  resetPending(vim);

  // In prompt normal mode, don't type characters
  if (context === "prompt" && key.type === "char") {
    return { type: "noop" };
  }

  // In sidebar/history, passthrough to existing handlers
  return { type: "passthrough" };
}

// ── Execute a keymap command ───────────────────────────────────────

function executeCommand(
  cmd: VimCommand,
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  const count = vim.count ?? 1;

  switch (cmd.type) {
    case "motion":
      return executeMotion(cmd.name, count, vim, buffer, cursor);

    case "operator":
      vim.pendingOperator = cmd.name;
      // pendingOperatorKey is set by the caller (handleNormalMode)
      vim.pendingKeys = "";
      // Don't reset count — it carries to the motion (3dw)
      vim.count = null;
      return { type: "pending" };

    case "mode_change":
      return executeModeChange(cmd, vim, context, buffer, cursor);

    case "action":
      resetPending(vim);
      return { type: "action", action: cmd.action };

    case "standalone":
      return executeStandalone(cmd.name, count, vim, buffer, cursor);

    case "noop":
      resetPending(vim);
      return { type: "noop" };
  }
}

// ── Motion execution ───────────────────────────────────────────────

function executeMotion(
  name: string,
  count: number,
  vim: VimState,
  buffer: string,
  cursor: number,
): VimResult {
  const motionFn = resolveMotion(name);
  if (!motionFn) { resetPending(vim); return { type: "noop" }; }

  let pos = cursor;
  for (let i = 0; i < count; i++) {
    pos = motionFn(buffer, pos);
  }

  // Normal mode: cursor can't go past last character
  pos = clampNormal(buffer, pos);

  resetPending(vim);
  return { type: "cursor_move", cursor: pos };
}

// ── Operator + motion execution ────────────────────────────────────

function executeOperatorMotion(
  operator: string,
  motionName: string,
  vim: VimState,
  buffer: string,
  cursor: number,
): VimResult {
  const count = vim.count ?? 1;
  const motionFn = resolveMotion(motionName);
  if (!motionFn) return { type: "noop" };

  // Compute the range: from cursor to where the motion lands
  let target = cursor;
  for (let i = 0; i < count; i++) {
    target = motionFn(buffer, target);
  }

  const start = Math.min(cursor, target);
  const end = Math.max(cursor, target);

  if (start === end) return { type: "noop" };

  return applyOperatorToRange(operator, buffer, start, end);
}

// ── Operator + text object execution ──────────────────────────────

function executeOperatorTextObject(
  operator: string,
  modifier: "i" | "a",
  objectKey: string,
  _vim: VimState,
  buffer: string,
  cursor: number,
): VimResult {
  const range = resolveTextObject(modifier, objectKey, buffer, cursor);
  if (!range || range.start === range.end) return { type: "noop" };

  return applyOperatorToRange(operator, buffer, range.start, range.end);
}

// ── Shared operator application ────────────────────────────────────

/** Apply an operator to a range. Used by both motion and text object paths. */
function applyOperatorToRange(
  operator: string,
  buffer: string,
  start: number,
  end: number,
): VimResult {
  switch (operator) {
    case "delete": {
      const edit = ops.deleteRange(buffer, start, end);
      return { type: "buffer_edit", ...edit };
    }
    case "change": {
      const edit = ops.deleteRange(buffer, start, end);
      return { type: "buffer_edit", ...edit, mode: "insert" };
    }
    case "yank": {
      const text = buffer.slice(start, end);
      return { type: "yank", text };
    }
    default:
      return { type: "noop" };
  }
}

// ── Mode change execution ──────────────────────────────────────────

function executeModeChange(
  cmd: { type: "mode_change"; mode: VimMode; cursor?: "before" | "after" | "bol" | "eol" },
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  vim.mode = cmd.mode;
  resetPending(vim);

  // Set visual anchor when entering visual mode
  if (cmd.mode === "visual" || cmd.mode === "visual-line") {
    vim.visualAnchor = cursor;
    return { type: "mode_change", mode: cmd.mode, cursor };
  }

  let newCursor = cursor;
  if (context === "prompt") {
    switch (cmd.cursor) {
      case "after": newCursor = Math.min(cursor + 1, buffer.length); break;
      case "bol":   newCursor = lineStartOf(buffer, cursor); break;
      case "eol":   newCursor = lineEndOf(buffer, cursor); break;
      // "before" or undefined: stay at current position
    }
  }

  // For sidebar/history: i/a → focus prompt + enter insert
  if (context !== "prompt" && cmd.mode === "insert") {
    return { type: "action", action: "focus_prompt" };
  }

  return { type: "mode_change", mode: cmd.mode, cursor: newCursor };
}

// ── Standalone command execution ───────────────────────────────────

function executeStandalone(
  name: string,
  count: number,
  vim: VimState,
  buffer: string,
  cursor: number,
): VimResult {
  resetPending(vim);

  let edit: BufferEdit;

  switch (name) {
    case "delete_char":
      edit = ops.deleteChar(buffer, cursor);
      return { type: "buffer_edit", ...edit };

    case "delete_char_before":
      edit = ops.deleteCharBefore(buffer, cursor);
      return { type: "buffer_edit", ...edit };

    case "delete_line":
      edit = applyN(count, buffer, cursor, ops.deleteLine);
      return { type: "buffer_edit", ...edit };

    case "change_line":
      edit = ops.changeLine(buffer, cursor);
      vim.mode = "insert";
      return { type: "buffer_edit", ...edit, mode: "insert" };

    case "delete_to_eol":
      edit = ops.deleteToEnd(buffer, cursor);
      return { type: "buffer_edit", ...edit };

    case "change_to_eol":
      edit = ops.changeToEnd(buffer, cursor);
      vim.mode = "insert";
      return { type: "buffer_edit", ...edit, mode: "insert" };

    case "open_below":
      edit = ops.openLineBelow(buffer, cursor);
      vim.mode = "insert";
      return { type: "buffer_edit", ...edit, mode: "insert" };

    case "open_above":
      edit = ops.openLineAbove(buffer, cursor);
      vim.mode = "insert";
      return { type: "buffer_edit", ...edit, mode: "insert" };

    case "yank_line": {
      const ls = lineStartOf(buffer, cursor);
      const le = lineEndOf(buffer, cursor);
      // Include the trailing newline if it exists
      const end = le < buffer.length ? le + 1 : le;
      const text = buffer.slice(ls, end);
      return { type: "yank", text };
    }

    case "paste_after":
      return { type: "paste", position: "after" };

    case "paste_before":
      return { type: "paste", position: "before" };

    case "undo":
      return { type: "undo" };

    default:
      return { type: "noop" };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Apply a line-level operation N times (for counted dd, etc). */
function applyN(
  count: number,
  buffer: string,
  cursor: number,
  fn: (buf: string, pos: number) => BufferEdit,
): BufferEdit {
  let buf = buffer;
  let pos = cursor;
  for (let i = 0; i < count; i++) {
    if (buf.length === 0) break;
    const result = fn(buf, pos);
    buf = result.buffer;
    pos = result.cursor;
  }
  return { buffer: buf, cursor: pos };
}
