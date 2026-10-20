/**
 * /instructions: a picker of the three instruction scopes (this
 * conversation, its folder, every conversation) and a centred Vim editor for
 * the chosen one. Instructions are not shown in the chat history; this modal
 * is where they are read and changed.
 */

import { createVimState, type VimState } from "../vim";
import { createUndoState, type UndoState } from "../undo";
import { sanitizePromptTextForInsertion } from "../prompttext";

export type InstructionScope = "conversation" | "folder" | "global";

/** Picker order, top to bottom: narrowest scope first. */
export const INSTRUCTION_SCOPES: readonly InstructionScope[] = ["conversation", "folder", "global"];

/** Where instructions for each scope go, captured when the modal opens. */
export interface InstructionsTarget {
  /** Null in a draft: saving conversation instructions creates the conversation. */
  convId: string | null;
  convTitle: string | null;
  /** The conversation's (or draft's) folder; null outside folders. */
  folderId: string | null;
  folderName: string | null;
}

export type InstructionsNoticeTone = "info" | "success" | "warning" | "error";

export interface InstructionsNotice {
  text: string;
  tone: InstructionsNoticeTone;
}

export interface InstructionsPickerState {
  target: InstructionsTarget;
  /** Each scope's text as the TUI has it; null until known or when the scope does not apply. */
  texts: Record<InstructionScope, string | null>;
  /** Why a scope's last save failed; Enter brings its text back. */
  failures: Record<InstructionScope, string | null>;
  /** The background check of these texts against the daemon. */
  loadReqId: string | null;
  error: string | null;
  /** Index into INSTRUCTION_SCOPES. */
  selection: number;
}

export interface InstructionsEditorState {
  scope: InstructionScope;
  target: InstructionsTarget;
  /** The text as loaded or last saved; the buffer is dirty when it differs. */
  savedText: string;
  buffer: string;
  cursor: number;
  vim: VimState;
  undo: UndoState;
  /** Preferred display column for j/k, as in the prompt. */
  curswant: number | null;
  /** First visible display row. */
  scroll: number;
  /** The text typed after ":" while the command line is open. */
  command: string | null;
  notice: InstructionsNotice | null;
  /** Set while the text has not arrived (the editor was opened without the picker). */
  loadReqId: string | null;
  /** Esc was pressed with unsaved changes: another Esc discards them. */
  confirmDiscard: boolean;
  /** Body size from the last frame, for Ctrl-D/U and wrapping. */
  viewRows: number;
  viewWidth: number;
}

export interface InstructionsModalState {
  /** Null when the editor was opened directly (the sidebar's AGENTS.md). */
  picker: InstructionsPickerState | null;
  editor: InstructionsEditorState | null;
}

export function scopeLabel(scope: InstructionScope): string {
  switch (scope) {
    case "conversation": return "Conversation";
    case "folder": return "Folder";
    case "global": return "Global";
  }
}

/** Who a scope's instructions apply to, for the picker and the editor title. */
export function scopeReach(scope: InstructionScope, target: InstructionsTarget): string {
  switch (scope) {
    case "conversation":
      return target.convId ? target.convTitle?.trim() || "this conversation" : "the new conversation";
    case "folder":
      return target.folderId ? `every conversation in ${target.folderName ?? "this folder"}/` : "not in a folder";
    case "global":
      return "every conversation";
  }
}

/** Whether a scope can be edited for this target. */
export function scopeAvailable(scope: InstructionScope, target: InstructionsTarget): boolean {
  return scope !== "folder" || target.folderId !== null;
}

export function createInstructionsEditor(
  scope: InstructionScope,
  target: InstructionsTarget,
  text: string | null,
): InstructionsEditorState {
  // The buffer holds prompt-safe text: tabs as spaces, no terminal controls.
  const loaded = sanitizePromptTextForInsertion(text ?? "");
  const vim = createVimState();
  // An empty document starts typing at once; existing text opens for reading.
  vim.mode = loaded ? "normal" : "insert";
  return {
    scope,
    target,
    savedText: loaded,
    buffer: loaded,
    cursor: 0,
    vim,
    undo: createUndoState(),
    curswant: null,
    scroll: 0,
    command: null,
    notice: null,
    loadReqId: null,
    confirmDiscard: false,
    viewRows: 10,
    viewWidth: 60,
  };
}

/** Fill an editor that was waiting for its text. */
export function setInstructionsEditorText(editor: InstructionsEditorState, raw: string): void {
  const text = sanitizePromptTextForInsertion(raw);
  editor.savedText = text;
  editor.buffer = text;
  editor.cursor = 0;
  editor.scroll = 0;
  editor.curswant = null;
  editor.undo = createUndoState();
  editor.vim = createVimState();
  editor.vim.mode = text ? "normal" : "insert";
  editor.loadReqId = null;
}

export function isInstructionsEditorDirty(editor: InstructionsEditorState): boolean {
  return editor.buffer !== editor.savedText;
}

/** "empty", or the first line and the size, for the picker. */
export function summarizeInstructions(text: string | null): { preview: string; size: string } | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return { preview: "", size: "" };
  const firstLine = trimmed.split("\n").find(line => line.trim())?.trim() ?? "";
  const lines = trimmed.split("\n").length;
  const chars = [...trimmed].length;
  const size = `${lines} ${lines === 1 ? "line" : "lines"} · ${chars.toLocaleString("en-US")} ${chars === 1 ? "char" : "chars"}`;
  return { preview: firstLine, size };
}
