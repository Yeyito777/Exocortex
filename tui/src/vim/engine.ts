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
import {
  resolveMotion, reverseFindKind, firstNonBlank, wordEnd, wordEndBig, type FindKind,
} from "./motions";
import { resolveTextObject, isTextObjectKey } from "./textobjects";
import { lineStartOf, lineEndOf, clampNormal, nextGraphemeEnd, previousGraphemeStart } from "./buffer";
import { isBufferSpace, isPunct, isWordChar } from "../chars";
import * as ops from "./operators";
import { applyFindMotion, handleVisualMode } from "./visual";

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
      newCursor = previousGraphemeStart(buffer, newCursor);
    }
    newCursor = clampNormal(buffer, newCursor);
    return { type: "mode_change", mode: "normal", cursor: newCursor };
  }
  // Everything else passes through to promptline / existing system
  return { type: "passthrough" };
}

// ── Find helpers ──────────────────────────────────────────────────

/** Apply a find with a pending operator. f/t include the target; F/T exclude the cursor's character. */
function applyFindOperator(vim: VimState, kind: FindKind, char: string, buffer: string, cursor: number, repeat: boolean): VimResult {
  const operator = vim.pendingOperator!;
  const count = (vim.operatorCount ?? 1) * (vim.count ?? 1);
  const moved = applyFindMotion(vim, kind, char, buffer, cursor, repeat, count);
  if (moved.type !== "cursor_move") return moved;
  const forward = kind === "f" || kind === "t";
  const start = forward ? cursor : moved.cursor;
  const end = forward ? nextGraphemeEnd(buffer, moved.cursor) : cursor;
  if (start >= end) return { type: "noop" };
  return applyOperatorToRange(operator, buffer, start, end);
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

  // Ctrl+R in prompt normal mode → redo.
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

  // A shift prefix requires the same second key, not a new find/replace/count.
  if ((vim.pendingKeys === "<" || vim.pendingKeys === ">") && ks !== vim.pendingKeys) {
    resetPending(vim);
    return { type: "noop" };
  }

  // ── Pending find (f/F/t/T waiting for character) ────────────────
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { resetPending(vim); return { type: "noop" }; }
    if (vim.pendingOperator) {
      return applyFindOperator(vim, vim.pendingFind, key.char, buffer, cursor, false);
    }
    return applyFindMotion(vim, vim.pendingFind, key.char, buffer, cursor, false);
  }

  // ── Pending replace (r waiting for character) ──────────────────
  if (vim.pendingReplace) {
    resetPending(vim);
    if (key.type !== "char" || !key.char) { return { type: "noop" }; }
    const edit = ops.replaceChar(buffer, cursor, key.char);
    if (edit.buffer === buffer) return { type: "noop" };
    return { type: "buffer_edit", ...edit };
  }

  // ── Count prefix ───────────────────────────────────────────────
  // Digits 1-9 start a count, 0 only continues (0 alone is line_start motion)
  if (/^[1-9]$/.test(ks) || (ks === "0" && vim.count !== null)) {
    vim.count = (vim.count ?? 0) * 10 + parseInt(ks, 10);
    return { type: "pending" };
  }

  // ── r — initiate replace (prompt only) ──────────────────────────
  if (ks === "r" && context === "prompt" && !vim.pendingOperator) {
    vim.pendingReplace = true;
    return { type: "pending" };
  }

  // ── f/F/t/T — initiate find; ;/, — repeat last find ────────────
  if (ks === "f" || ks === "F" || (context === "prompt" && (ks === "t" || ks === "T"))) {
    vim.pendingFind = ks;
    return { type: "pending" };
  }
  if (ks === ";" || ks === ",") {
    if (!vim.lastFind) { resetPending(vim); return { type: "noop" }; }
    const kind = ks === ";" ? vim.lastFind.direction : reverseFindKind(vim.lastFind.direction);
    if (vim.pendingOperator) {
      return applyFindOperator(vim, kind, vim.lastFind.char, buffer, cursor, true);
    }
    return applyFindMotion(vim, kind, vim.lastFind.char, buffer, cursor, true);
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
      // A count before the operator multiplies the motion's (3dw, 2d3w, 3dd)
      vim.operatorCount = vim.count;
      vim.count = null;
      return { type: "pending" };

    case "mode_change":
      return executeModeChange(cmd, vim, context, buffer, cursor);

    case "action":
      resetPending(vim);
      return { type: "action", action: cmd.action };

    case "standalone":
      return executeStandalone(cmd.name, (vim.operatorCount ?? 1) * count, vim, buffer, cursor);

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
  return { type: "cursor_move", cursor: pos, motion: name, count };
}

// ── Operator + motion execution ────────────────────────────────────

/** Character class for Vim's word motions: 0 blank, 1 punctuation, 2 word. */
function wordClass(ch: string | undefined, big: boolean): number {
  if (ch === undefined || isBufferSpace(ch)) return 0;
  if (big) return 2;
  return isWordChar(ch) ? 2 : isPunct(ch) ? 1 : 0;
}

/**
 * cw/cW on a non-blank — Vim changes to the end of the word, like ce/cE,
 * except the cursor's own word counts even when already on its last character.
 */
function changeWordEnd(buffer: string, cursor: number, count: number, big: boolean): number {
  const cls = wordClass(buffer[cursor], big);
  let end = wordClass(buffer[cursor + 1], big) === cls ? (big ? wordEndBig : wordEnd)(buffer, cursor) : cursor;
  for (let i = 1; i < count; i++) end = (big ? wordEndBig : wordEnd)(buffer, end);
  return end;
}

function executeOperatorMotion(
  operator: string,
  motionName: string,
  vim: VimState,
  buffer: string,
  cursor: number,
): VimResult {
  const count = (vim.operatorCount ?? 1) * (vim.count ?? 1);

  // j/k are linewise: operate on whole lines (dj, yk, 2cj)
  if (motionName === "line_down" || motionName === "line_up") {
    const span = ops.lineSpan(buffer, cursor, motionName === "line_down" ? count : -count);
    if (span.first === lineStartOf(buffer, cursor) && span.last === lineEndOf(buffer, cursor)) {
      return { type: "noop" };
    }
    return applyOperatorToLines(operator, buffer, span.first, span.last);
  }

  const isWordForward = motionName === "word_forward" || motionName === "word_forward_big";
  if (operator === "change" && isWordForward && cursor < buffer.length && !isBufferSpace(buffer[cursor])) {
    const end = changeWordEnd(buffer, cursor, count, motionName === "word_forward_big");
    return applyOperatorToRange(operator, buffer, cursor, nextGraphemeEnd(buffer, end));
  }

  // dl/xl may reach the end of the line, unlike the normal-mode l motion
  if (motionName === "char_right") {
    const le = lineEndOf(buffer, cursor);
    let target = cursor;
    for (let i = 0; i < count && target < le; i++) target = nextGraphemeEnd(buffer, target);
    return target === cursor ? { type: "noop" } : applyOperatorToRange(operator, buffer, cursor, target);
  }

  const motionFn = resolveMotion(motionName);
  if (!motionFn) return { type: "noop" };

  // Compute the range: from cursor to where the motion lands
  let from = cursor;
  let target = cursor;
  for (let i = 0; i < count; i++) {
    from = target;
    target = motionFn(buffer, target);
  }
  if (target === cursor) return { type: "noop" };

  // An operated w/W whose last word ends its line stops at that line's end
  // rather than eating the line break (dw on a line's last word).
  if (isWordForward && buffer.slice(from, target).includes("\n")) {
    const le = lineEndOf(buffer, from);
    if (le > from) target = le;
  }

  const start = Math.min(cursor, target);
  let end = Math.max(cursor, target);
  // e/E are inclusive: the word's last character is part of the range
  if (motionName === "word_end" || motionName === "word_end_big") end = nextGraphemeEnd(buffer, end);

  return applyOperatorToRange(operator, buffer, start, end);
}

/** Apply an operator to whole lines [first line start, last line end]. */
function applyOperatorToLines(operator: string, buffer: string, first: number, last: number): VimResult {
  switch (operator) {
    case "delete":
      return { type: "buffer_edit", ...ops.deleteLines(buffer, first, last) };
    case "change":
      return { type: "buffer_edit", ...ops.changeLines(buffer, first, last), mode: "insert" };
    case "yank":
      return { type: "yank", text: ops.linewiseText(buffer, first, last), linewise: true };
    default:
      return { type: "noop" };
  }
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
      case "after": newCursor = Math.min(nextGraphemeEnd(buffer, cursor), lineEndOf(buffer, cursor)); break;
      case "bol":   newCursor = firstNonBlank(buffer, cursor); break;
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
    case "shift_right":
    case "shift_left": {
      let end = lineEndOf(buffer, cursor);
      for (let i = 1; i < count && end < buffer.length; i++) {
        end = lineEndOf(buffer, end + 1);
      }
      edit = ops.shiftLines(buffer, cursor, end, name === "shift_right" ? 1 : -1);
      return edit.buffer === buffer
        ? { type: "cursor_move", cursor: edit.cursor }
        : { type: "buffer_edit", ...edit };
    }

    case "delete_char":
      return editOrNoop(buffer, ops.deleteChars(buffer, cursor, count));

    case "delete_char_before":
      return editOrNoop(buffer, ops.deleteCharsBefore(buffer, cursor, count));

    case "delete_line": {
      const span = ops.lineSpan(buffer, cursor, count - 1);
      return editOrNoop(buffer, ops.deleteLines(buffer, span.first, span.last));
    }

    case "change_line": {
      const span = ops.lineSpan(buffer, cursor, count - 1);
      edit = ops.changeLines(buffer, span.first, span.last);
      vim.mode = "insert";
      return { type: "buffer_edit", ...edit, mode: "insert" };
    }

    case "delete_to_eol":
      return editOrNoop(buffer, ops.deleteToEnd(buffer, cursor, count));

    case "change_to_eol":
      edit = ops.changeToEnd(buffer, cursor, count);
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
      const span = ops.lineSpan(buffer, cursor, count - 1);
      return { type: "yank", text: ops.linewiseText(buffer, span.first, span.last), linewise: true };
    }

    case "swap_case":
      edit = ops.swapCase(buffer, cursor, count);
      return { type: "buffer_edit", ...edit };

    case "paste_after":
      return { type: "paste", position: "after", count };

    case "paste_before":
      return { type: "paste", position: "before", count };

    case "undo":
      return { type: "undo" };

    default:
      return { type: "noop" };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** A buffer edit, or a no-op when nothing changed (so no empty undo step). */
function editOrNoop(buffer: string, edit: BufferEdit): VimResult {
  return edit.buffer === buffer ? { type: "noop" } : { type: "buffer_edit", ...edit };
}
