/**
 * Keys for the instructions editor: the prompt's Vim engine run against the
 * editor's own buffer, plus a small ":" command line (:w, :q, :wq, :x, :q!,
 * :w!). Esc in normal mode closes; with unsaved changes it asks once more.
 * Pure state edits — saving and closing are returned for the controller.
 */

import type { KeyEvent } from "../input";
import { processKey, copyToClipboard, pasteFromClipboard } from "../vim";
import { hasPending } from "../vim/types";
import { isLinewiseClipboardText } from "../vim/clipboard";
import { clampInsert, clampNormal, lineStartOf, nextGraphemeEnd, previousGraphemeStart } from "../vim/buffer";
import { putLines } from "../vim/operators";
import { pushUndo, markInsertEntry, commitInsertSession, undo as undoFn, redo as redoFn } from "../undo";
import { moveCursorVerticalByRows } from "../promptline";
import { sanitizePromptTextForInsertion } from "../prompttext";
import { PROMPT_TAB, promptDeleteEnd, promptDeleteStart } from "../prompttabs";
import { getSymbol } from "../symbols";
import { isInstructionsEditorDirty, type InstructionsEditorState } from "./state";
import { acceptToolsEdit, snapshotToolsEdit } from "./tools";

export type InstructionsEditorKeyResult =
  | { type: "handled" }
  /** Write the buffer; `force` skips the "changed elsewhere" check. */
  | { type: "save"; close: boolean; force: boolean }
  /** Close without saving. */
  | { type: "close" };

const HANDLED: InstructionsEditorKeyResult = { type: "handled" };

/** Arrow/Home/End keys act as their Vim motions outside insert mode, like the prompt. */
const ARROW_MOTIONS: Partial<Record<KeyEvent["type"], string>> = {
  left: "h", right: "l", up: "k", down: "j", home: "0", end: "$",
};

export const UNSAVED_WARNING = "Unsaved changes: :w saves, :q! or Esc again discards";
export const READ_ONLY_WARNING = "Read-only: nothing here can be edited or saved";

/** An edit in a read-only editor: stay in normal mode and say why. */
function refuseEdit(editor: InstructionsEditorState): InstructionsEditorKeyResult {
  editor.vim.mode = "normal";
  editor.notice = { text: editor.readOnlyNotice ?? READ_ONLY_WARNING, tone: "warning" };
  return HANDLED;
}

export function handleInstructionsEditorKey(
  key: KeyEvent,
  editor: InstructionsEditorState,
  onAsyncEdit?: () => void,
): InstructionsEditorKeyResult {
  // In /instructions tools only the blocks' text may change.
  const before = editor.tools?.editable && !editor.loadReqId ? snapshotToolsEdit(editor) : null;
  const result = handleEditorKey(key, editor, onAsyncEdit);
  if (before) acceptToolsEdit(editor, before);
  return result;
}

function handleEditorKey(
  key: KeyEvent,
  editor: InstructionsEditorState,
  onAsyncEdit?: () => void,
): InstructionsEditorKeyResult {
  if (editor.loadReqId) {
    // Nothing to edit yet; Esc and :q still leave.
    return key.type === "escape" || (key.type === "char" && key.char === "q") ? { type: "close" } : HANDLED;
  }
  if (editor.command !== null) return handleCommandLineKey(key, editor);

  const confirmDiscard = editor.confirmDiscard;
  editor.confirmDiscard = false;
  editor.notice = null;

  if (editor.readOnly && (key.type === "ctrl-s" || key.type === "paste")) return refuseEdit(editor);

  if (key.type === "ctrl-s") return { type: "save", close: false, force: false };

  if (key.type === "paste" && key.text) {
    insertText(editor, sanitizePromptTextForInsertion(key.text), true);
    return HANDLED;
  }

  if (editor.vim.mode === "insert") return handleInsertKey(key, editor);

  if (editor.vim.mode === "normal" && !hasPending(editor.vim)) {
    if (key.type === "escape") {
      if (!isInstructionsEditorDirty(editor) || confirmDiscard) return { type: "close" };
      editor.confirmDiscard = true;
      editor.notice = { text: UNSAVED_WARNING, tone: "warning" };
      return HANDLED;
    }
    if (key.type === "char" && key.char === ":") {
      editor.command = "";
      return HANDLED;
    }
    if (key.type === "ctrl-d" || key.type === "ctrl-u") {
      moveVertical(editor, key.type === "ctrl-d" ? 1 : -1, Math.max(1, Math.floor(editor.viewRows / 2)));
      return HANDLED;
    }
    if (key.type === "enter") {
      moveVertical(editor, 1, 1);
      return HANDLED;
    }
  }

  return applyVimKey(key, editor, onAsyncEdit);
}

// ── Command line ─────────────────────────────────────────────────────

function handleCommandLineKey(key: KeyEvent, editor: InstructionsEditorState): InstructionsEditorKeyResult {
  const command = editor.command ?? "";
  if (key.type === "escape") {
    editor.command = null;
    return HANDLED;
  }
  if (key.type === "backspace") {
    editor.command = command ? command.slice(0, -1) : null;
    return HANDLED;
  }
  if (key.type === "char" && key.char) {
    editor.command = command + key.char.replace(/[\x00-\x1f\x7f]/g, "");
    return HANDLED;
  }
  if (key.type === "paste" && key.text) {
    editor.command = command + key.text.replace(/[\x00-\x1f\x7f]/g, "");
    return HANDLED;
  }
  if (key.type !== "enter") return HANDLED;

  editor.command = null;
  return runEditorCommand(command.trim(), editor);
}

/** Run an ex command typed after ":". */
export function runEditorCommand(command: string, editor: InstructionsEditorState): InstructionsEditorKeyResult {
  if (editor.readOnly) {
    // Nothing to write: the quitting forms just close.
    if (["w", "write", "w!"].includes(command)) return refuseEdit(editor);
    if (["wq", "x", "xit", "wq!", "x!"].includes(command)) return { type: "close" };
  }
  switch (command) {
    case "":
      return HANDLED;
    case "w":
    case "write":
      return { type: "save", close: false, force: false };
    case "w!":
      return { type: "save", close: false, force: true };
    case "wq":
    case "x":
    case "xit":
      return isInstructionsEditorDirty(editor) || command.startsWith("w")
        ? { type: "save", close: true, force: false }
        : { type: "close" };
    case "wq!":
    case "x!":
      return { type: "save", close: true, force: true };
    case "q":
    case "quit":
      if (isInstructionsEditorDirty(editor)) {
        editor.notice = { text: UNSAVED_WARNING, tone: "warning" };
        editor.confirmDiscard = true;
        return HANDLED;
      }
      return { type: "close" };
    case "q!":
    case "quit!":
      return { type: "close" };
    default:
      editor.notice = { text: `Not an editor command: ${command}  (:w :q :wq :q!)`, tone: "error" };
      return HANDLED;
  }
}

// ── Insert mode ──────────────────────────────────────────────────────

function insertText(editor: InstructionsEditorState, text: string, asPaste = false): void {
  if (!text) return;
  if (asPaste) {
    // A paste is its own undo step, then typing continues in insert mode.
    commitInsertSession(editor.undo, editor.buffer);
    pushUndo(editor.undo, editor.buffer, editor.cursor);
  }
  const pos = clampInsert(editor.buffer, editor.cursor);
  editor.buffer = editor.buffer.slice(0, pos) + text + editor.buffer.slice(pos);
  editor.cursor = pos + text.length;
  editor.curswant = null;
  if (asPaste) {
    editor.vim.mode = "insert";
    markInsertEntry(editor.undo, editor.buffer, editor.cursor);
  }
}

function handleInsertKey(key: KeyEvent, editor: InstructionsEditorState): InstructionsEditorKeyResult {
  if (key.type === "escape") {
    const result = processKey(key, editor.vim, "prompt", editor.buffer, editor.cursor);
    commitInsertSession(editor.undo, editor.buffer);
    if (result.type === "mode_change" && result.cursor !== undefined) editor.cursor = result.cursor;
    editor.vim.mode = "normal";
    editor.curswant = null;
    return HANDLED;
  }

  const symbol = getSymbol(key);
  if (symbol) {
    insertText(editor, symbol);
    return HANDLED;
  }

  const buffer = editor.buffer;
  const pos = clampInsert(buffer, editor.cursor);
  switch (key.type) {
    case "char":
      insertText(editor, sanitizePromptTextForInsertion(key.char ?? ""));
      return HANDLED;
    case "enter":
    case "shift-enter":
    case "ctrl-l":
      insertText(editor, "\n");
      return HANDLED;
    case "tab":
      insertText(editor, PROMPT_TAB);
      return HANDLED;
    case "backspace":
      if (pos > 0) {
        const start = promptDeleteStart(buffer, pos);
        editor.buffer = buffer.slice(0, start) + buffer.slice(pos);
        editor.cursor = start;
      }
      editor.curswant = null;
      return HANDLED;
    case "delete":
      if (pos < buffer.length) editor.buffer = buffer.slice(0, pos) + buffer.slice(promptDeleteEnd(buffer, pos));
      editor.curswant = null;
      return HANDLED;
    case "left":
      editor.cursor = previousGraphemeStart(buffer, pos);
      editor.curswant = null;
      return HANDLED;
    case "right":
      editor.cursor = nextGraphemeEnd(buffer, pos);
      editor.curswant = null;
      return HANDLED;
    case "home":
      editor.cursor = lineStartOf(buffer, pos);
      editor.curswant = null;
      return HANDLED;
    case "end": {
      const nl = buffer.indexOf("\n", pos);
      editor.cursor = nl === -1 ? buffer.length : nl;
      editor.curswant = Infinity;
      return HANDLED;
    }
    case "up":
    case "down":
      moveVertical(editor, key.type === "up" ? -1 : 1, 1);
      return HANDLED;
    default:
      return HANDLED;
  }
}

// ── Normal / visual mode ─────────────────────────────────────────────

function moveVertical(editor: InstructionsEditorState, direction: -1 | 1, count: number): void {
  const normal = editor.vim.mode !== "insert";
  const move = moveCursorVerticalByRows(editor.buffer, editor.cursor, editor.curswant, editor.viewWidth, direction, count, normal);
  editor.cursor = normal ? clampNormal(editor.buffer, move.cursor) : move.cursor;
  editor.curswant = move.curswant;
}

function applyVimKey(key: KeyEvent, editor: InstructionsEditorState, onAsyncEdit?: () => void): InstructionsEditorKeyResult {
  const vim = editor.vim;
  const arrowMotion = !vim.pendingFind && !vim.pendingReplace ? ARROW_MOTIONS[key.type] : undefined;
  if (arrowMotion) {
    if (arrowMotion === "0") vim.count = null;
    key = { type: "char", char: arrowMotion };
  }
  const prevMode = vim.mode;
  const result = processKey(key, vim, "prompt", editor.buffer, editor.cursor);
  if (editor.readOnly && refusedWhenReadOnly(result)) return refuseEdit(editor);

  switch (result.type) {
    case "passthrough":
    case "noop":
    case "pending":
      return HANDLED;

    case "cursor_move":
      if (result.motion === "line_up" || result.motion === "line_down") {
        moveVertical(editor, result.motion === "line_up" ? -1 : 1, result.count ?? 1);
      } else {
        editor.cursor = result.cursor;
        editor.curswant = result.motion === "line_end" ? Infinity : null;
      }
      return HANDLED;

    case "buffer_edit":
      if (result.mode === "insert") markInsertEntry(editor.undo, editor.buffer, editor.cursor);
      else pushUndo(editor.undo, editor.buffer, editor.cursor);
      editor.buffer = result.buffer;
      editor.cursor = result.cursor;
      editor.curswant = null;
      if (result.mode) vim.mode = result.mode;
      else editor.cursor = clampNormal(editor.buffer, editor.cursor);
      return HANDLED;

    case "visual_edit":
      if (result.mode === "insert") markInsertEntry(editor.undo, editor.buffer, editor.cursor);
      else pushUndo(editor.undo, editor.buffer, editor.cursor);
      editor.buffer = result.buffer;
      editor.cursor = result.cursor;
      editor.curswant = null;
      vim.mode = result.mode;
      if (result.yankText !== undefined) copyToClipboard(result.yankText, result.yankLinewise);
      return HANDLED;

    case "yank":
      copyToClipboard(result.text, result.linewise);
      return HANDLED;

    case "paste":
      pasteIntoEditor(editor, result.position, result.count, onAsyncEdit);
      return HANDLED;

    case "undo":
    case "redo": {
      const snap = result.type === "undo"
        ? undoFn(editor.undo, editor.buffer, editor.cursor)
        : redoFn(editor.undo, editor.buffer, editor.cursor);
      if (snap) {
        editor.buffer = snap.buffer;
        editor.cursor = clampNormal(snap.buffer, snap.cursor);
        editor.curswant = null;
      }
      return HANDLED;
    }

    case "mode_change":
      if (prevMode === "insert" && result.mode !== "insert") commitInsertSession(editor.undo, editor.buffer);
      vim.mode = result.mode;
      if (result.cursor !== undefined) {
        editor.cursor = result.cursor;
        editor.curswant = null;
      }
      if (result.mode === "insert") markInsertEntry(editor.undo, editor.buffer, editor.cursor);
      return HANDLED;

    case "action":
      // gg and G move through the document; the chat-only actions do nothing here.
      if (result.action === "scroll_top") {
        editor.cursor = 0;
        editor.curswant = null;
      } else if (result.action === "scroll_bottom") {
        editor.cursor = clampNormal(editor.buffer, lineStartOf(editor.buffer, editor.buffer.length));
        editor.curswant = null;
      }
      return HANDLED;
  }
}

/** Results that would change the text or start typing. Yanks and motions stay. */
function refusedWhenReadOnly(result: ReturnType<typeof processKey>): boolean {
  switch (result.type) {
    case "buffer_edit":
    case "visual_edit":
    case "paste":
    case "undo":
    case "redo":
      return true;
    case "mode_change":
      return result.mode === "insert";
    default:
      return false;
  }
}

/** p/P from the clipboard: whole lines when it holds a linewise yank, like Vim. */
function pasteIntoEditor(
  editor: InstructionsEditorState,
  position: "after" | "before",
  count: number,
  onAsyncEdit?: () => void,
): void {
  void pasteFromClipboard().then((raw) => {
    const text = sanitizePromptTextForInsertion(raw);
    if (!text) return;
    const before = editor.tools?.editable ? snapshotToolsEdit(editor) : null;
    pushUndo(editor.undo, editor.buffer, editor.cursor);
    const buf = editor.buffer;
    const cursor = editor.cursor;
    if (isLinewiseClipboardText(text)) {
      const lines = text.endsWith("\n") ? text : text + "\n";
      const edit = putLines(buf, cursor, lines.repeat(count), position === "after");
      editor.buffer = edit.buffer;
      editor.cursor = edit.cursor;
    } else {
      const insertAt = position === "after" && buf[cursor] !== "\n" && buf.length > 0 ? nextGraphemeEnd(buf, cursor) : cursor;
      const pos = Math.min(insertAt, buf.length);
      const pasted = text.repeat(count);
      editor.buffer = buf.slice(0, pos) + pasted + buf.slice(pos);
      editor.cursor = clampNormal(editor.buffer, previousGraphemeStart(editor.buffer, pos + pasted.length));
    }
    editor.curswant = null;
    if (before) acceptToolsEdit(editor, before);
    onAsyncEdit?.();
  });
}
