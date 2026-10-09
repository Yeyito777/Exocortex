/**
 * Visual and visual-line mode handling.
 *
 * Owns mode toggling, find within visual, motion-extends-selection,
 * text object selection, and operator execution on selections
 * (yank, delete, change).
 */

import type { KeyEvent } from "../input";
import type { VimState, VimCommand, VimContext, VimResult } from "./types";
import { resetPending, keyString } from "./types";
import { lookupCommand, isPrefix } from "./keymap";
import { resolveMotion, findCharCount, reverseFindKind, type FindKind } from "./motions";
import { resolveTextObject, isTextObjectKey } from "./textobjects";
import { lineStartOf, lineEndOf, clampNormal, nextGraphemeEnd, previousGraphemeStart } from "./buffer";
import { shiftLines, swapCaseRange } from "./operators";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Apply a find (f/F/t/T, or a ;/, repeat) as a motion, `count` times — in
 * normal mode or to extend a selection. Only a new find (not a repeat) is
 * stored for ; and ,.
 */
export function applyFindMotion(
  vim: VimState, kind: FindKind, char: string, buffer: string, cursor: number, repeat: boolean,
  count = vim.count ?? 1,
): VimResult {
  if (!repeat) vim.lastFind = { char, direction: kind };
  const target = findCharCount(buffer, cursor, char, kind, count, repeat);
  resetPending(vim);
  return target === null ? { type: "noop" } : { type: "cursor_move", cursor: target };
}

function exitVisual(vim: VimState, cursor: number): VimResult {
  vim.mode = "normal";
  resetPending(vim);
  return { type: "mode_change", mode: "normal", cursor };
}

// ── Visual mode entry point ──────────────────────────────────────

export function handleVisualMode(
  key: KeyEvent,
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  const ks = keyString(key);

  // Exit / toggle visual modes
  if (ks === "escape"
    || (ks === "v" && vim.mode === "visual")
    || (ks === "V" && vim.mode === "visual-line")) {
    return exitVisual(vim, cursor);
  }

  // Switch between visual ↔ visual-line
  if (ks === "V" && vim.mode === "visual") {
    vim.mode = "visual-line";
    return { type: "mode_change", mode: "visual-line", cursor };
  }
  if (ks === "v" && vim.mode === "visual-line") {
    vim.mode = "visual";
    return { type: "mode_change", mode: "visual", cursor };
  }

  if (ks === null) return { type: "passthrough" };

  if ((vim.pendingKeys === "<" || vim.pendingKeys === ">") && ks !== vim.pendingKeys) {
    resetPending(vim);
    return { type: "noop" };
  }

  // Pending find (f/F/t/T waiting for character) in visual
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { resetPending(vim); return { type: "noop" }; }
    return applyFindMotion(vim, vim.pendingFind, key.char, buffer, cursor, false);
  }

  // f/F/t/T — initiate find; ;/, — repeat last find (extends selection)
  if (ks === "f" || ks === "F" || (context === "prompt" && (ks === "t" || ks === "T"))) {
    vim.pendingFind = ks;
    return { type: "pending" };
  }
  if (ks === ";" || ks === ",") {
    // An exact context binding takes precedence over the built-in repeat-find
    // keys. History uses visual `;` to append the selection to the prompt.
    const boundCommand = lookupCommand(vim.mode, context, ks);
    if (boundCommand) return executeVisualCommand(boundCommand, vim, context, buffer, cursor);

    if (!vim.lastFind) { resetPending(vim); return { type: "noop" }; }
    const kind = ks === ";" ? vim.lastFind.direction : reverseFindKind(vim.lastFind.direction);
    return applyFindMotion(vim, kind, vim.lastFind.char, buffer, cursor, true);
  }

  // ── Text objects (i/a + specifier) ─────────────────────────────
  // Pending modifier waiting for specifier key (", ', w, (, m, …).
  // The "m" (message) specifier is handled by the pre-engine interceptor
  // in message.ts; standard specifiers are resolved here.
  if (vim.pendingTextObjectModifier) {
    const modifier = vim.pendingTextObjectModifier;
    vim.pendingTextObjectModifier = null;
    if (isTextObjectKey(ks)) {
      const range = resolveTextObject(modifier, ks, buffer, cursor);
      if (range && range.start !== range.end) {
        vim.visualAnchor = range.start;
        return { type: "cursor_move", cursor: previousGraphemeStart(buffer, range.end) };
      }
    }
    return { type: "noop" };
  }

  // ── Count prefix (3j, 2w) ──────────────────────────────────────
  if (context === "prompt" && (/^[1-9]$/.test(ks) || (ks === "0" && vim.count !== null))) {
    vim.count = (vim.count ?? 0) * 10 + parseInt(ks, 10);
    return { type: "pending" };
  }

  // "i" or "a" → start text object modifier
  if (ks === "i" || ks === "a") {
    vim.pendingTextObjectModifier = ks;
    return { type: "pending" };
  }

  // Multi-key sequence support (gg in visual)
  const fullKey = vim.pendingKeys + ks;

  const cmd = lookupCommand(vim.mode, context, fullKey);
  if (cmd) {
    vim.pendingKeys = "";
    return executeVisualCommand(cmd, vim, context, buffer, cursor);
  }

  if (isPrefix(vim.mode, context, fullKey)) {
    vim.pendingKeys = fullKey;
    return { type: "pending" };
  }

  resetPending(vim);
  return { type: "noop" };
}

// ── Command execution ────────────────────────────────────────────

/** Execute a command in visual mode. Motions extend selection, standalones act on it. */
function executeVisualCommand(
  cmd: VimCommand,
  vim: VimState,
  context: VimContext,
  buffer: string,
  cursor: number,
): VimResult {
  switch (cmd.type) {
    case "motion": {
      // Motion extends selection by moving cursor (anchor stays)
      const motionFn = resolveMotion(cmd.name);
      const count = vim.count ?? 1;
      resetPending(vim);
      if (!motionFn) return { type: "noop" };
      let newPos = cursor;
      for (let i = 0; i < count; i++) newPos = motionFn(buffer, newPos);
      return { type: "cursor_move", cursor: newPos, motion: cmd.name, count };
    }

    case "action":
      // History motions — dispatch to focus.ts, anchor stays
      return { type: "action", action: cmd.action };

    case "standalone": {
      const anchor = vim.visualAnchor;
      resetPending(vim);
      if (cmd.name === "visual_swap_ends") {
        // o — jump to the other end of the selection
        vim.visualAnchor = cursor;
        return { type: "cursor_move", cursor: anchor };
      }
      if (cmd.name === "visual_shift_right" || cmd.name === "visual_shift_left") {
        const edit = shiftLines(buffer, anchor, cursor, cmd.name === "visual_shift_right" ? 1 : -1);
        const exited = exitVisual(vim, edit.cursor);
        if (edit.buffer === buffer) return exited;
        return { type: "visual_edit", ...edit, mode: "normal" };
      }
      let start = Math.min(anchor, cursor);
      let end = Math.max(anchor, cursor);

      // Visual-line: expand to full lines
      const linewise = vim.mode === "visual-line";
      if (linewise) {
        start = lineStartOf(buffer, start);
        end = lineEndOf(buffer, end);
        // Include trailing newline
        if (end < buffer.length) end++;
      } else {
        // Character visual: inclusive of the grapheme under the cursor
        end = Math.min(nextGraphemeEnd(buffer, end), buffer.length);
      }

      const text = buffer.slice(start, end);
      // A linewise register is always \n-terminated, even for the last line
      const yankText = linewise && !text.endsWith("\n") ? text + "\n" : text;

      switch (cmd.name) {
        case "visual_yank":
          exitVisual(vim, cursor);
          return { type: "yank", text: yankText, linewise };

        case "visual_delete": {
          if (context !== "prompt") return exitVisual(vim, cursor);
          const newBuf = buffer.slice(0, start) + buffer.slice(end);
          const newCursor = clampNormal(newBuf, start);
          exitVisual(vim, newCursor);
          return { type: "visual_edit", buffer: newBuf, cursor: newCursor, mode: "normal" };
        }

        case "visual_delete_yank": {
          if (context !== "prompt") return exitVisual(vim, cursor);
          const newBuf = buffer.slice(0, start) + buffer.slice(end);
          const newCursor = clampNormal(newBuf, start);
          exitVisual(vim, newCursor);
          return {
            type: "visual_edit", buffer: newBuf, cursor: newCursor, mode: "normal",
            yankText, yankLinewise: linewise,
          };
        }

        case "visual_change": {
          if (context !== "prompt") return exitVisual(vim, cursor);
          const newBuf = buffer.slice(0, start) + buffer.slice(end);
          vim.mode = "insert";
          resetPending(vim);
          return { type: "visual_edit", buffer: newBuf, cursor: start, mode: "insert" };
        }

        case "visual_swap_case": {
          if (context !== "prompt") return exitVisual(vim, cursor);
          const edit = swapCaseRange(buffer, start, end);
          exitVisual(vim, edit.cursor);
          return { type: "visual_edit", buffer: edit.buffer, cursor: edit.cursor, mode: "normal" };
        }

        default:
          return { type: "noop" };
      }
    }

    default:
      return { type: "noop" };
  }
}
