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
import { resolveMotion, findForward, findBackward } from "./motions";
import { resolveTextObject, isTextObjectKey } from "./textobjects";
import { lineStartOf, lineEndOf, clampNormal } from "./buffer";
import { swapCaseRange } from "./operators";

// ── Helpers ──────────────────────────────────────────────────────

function resolveFind(dir: "f" | "F", char: string, buffer: string, pos: number): number {
  return dir === "f" ? findForward(buffer, pos, char) : findBackward(buffer, pos, char);
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

  // Pending find (f/F waiting for character) in visual
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { vim.pendingFind = null; return { type: "noop" }; }
    vim.lastFind = { char: key.char, direction: vim.pendingFind };
    vim.pendingFind = null;
    const newPos = resolveFind(vim.lastFind.direction, vim.lastFind.char, buffer, cursor);
    return { type: "cursor_move", cursor: newPos };
  }

  // f/F — initiate find; ;/, — repeat last find (extends selection)
  if (ks === "f" || ks === "F") {
    vim.pendingFind = ks;
    return { type: "pending" };
  }
  if (ks === ";" || ks === ",") {
    if (!vim.lastFind) return { type: "noop" };
    const dir = ks === ";" ? vim.lastFind.direction
      : (vim.lastFind.direction === "f" ? "F" : "f") as "f" | "F";
    const newPos = resolveFind(dir, vim.lastFind.char, buffer, cursor);
    return { type: "cursor_move", cursor: newPos };
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
        return { type: "cursor_move", cursor: range.end - 1 };
      }
    }
    return { type: "noop" };
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
      if (!motionFn) return { type: "noop" };
      const newPos = motionFn(buffer, cursor);
      return { type: "cursor_move", cursor: newPos };
    }

    case "action":
      // History motions — dispatch to focus.ts, anchor stays
      return { type: "action", action: cmd.action };

    case "standalone": {
      const anchor = vim.visualAnchor;
      let start = Math.min(anchor, cursor);
      let end = Math.max(anchor, cursor);

      // Visual-line: expand to full lines
      if (vim.mode === "visual-line") {
        start = lineStartOf(buffer, start);
        end = lineEndOf(buffer, end);
        // Include trailing newline
        if (end < buffer.length) end++;
      } else {
        // Character visual: inclusive (end + 1 for slice)
        end = Math.min(end + 1, buffer.length);
      }

      const text = buffer.slice(start, end);

      switch (cmd.name) {
        case "visual_yank":
          exitVisual(vim, cursor);
          return { type: "yank", text };

        case "visual_delete": {
          if (context !== "prompt") return exitVisual(vim, cursor);
          const newBuf = buffer.slice(0, start) + buffer.slice(end);
          const newCursor = clampNormal(newBuf, start);
          exitVisual(vim, newCursor);
          return { type: "visual_edit", buffer: newBuf, cursor: newCursor, mode: "normal" };
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
