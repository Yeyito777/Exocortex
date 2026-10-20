/**
 * /instructions controller: opens the picker or an editor, routes their keys,
 * saves through the daemon command for each scope (set_system_instructions,
 * set_folder_instructions, set_global_instructions) and settles saves and
 * loads from the daemon's answers.
 */

import type { KeyEvent } from "../input";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { handleInstructionsEditorKey } from "./editor";
import {
  createInstructionsEditor,
  INSTRUCTION_SCOPES,
  isInstructionsEditorDirty,
  scopeAvailable,
  scopeLabel,
  setInstructionsEditorText,
  type InstructionScope,
  type InstructionsEditorState,
  type InstructionsModalState,
  type InstructionsPickerState,
  type InstructionsTarget,
} from "./state";

export interface InstructionsLoader {
  loadInstructions(convId: string | null, folderId: string | null): string;
}

export interface InstructionsDaemon extends InstructionsLoader {
  setSystemInstructions(convId: string, text: string): string;
  setFolderInstructions(folderId: string, text: string): string;
  setGlobalInstructions(text: string, expectedText?: string): string;
}

export type InstructionsKeyOutcome =
  | { type: "handled" }
  /** Conversation instructions saved from a draft: create the conversation with them. */
  | { type: "create_conversation"; text: string };

const HANDLED: InstructionsKeyOutcome = { type: "handled" };

/** The open conversation (or draft) and its folder. */
export function currentInstructionsTarget(state: RenderState): InstructionsTarget {
  const conversation = state.convId ? state.sidebar.conversations.find(conv => conv.id === state.convId) : undefined;
  const folderId = state.convId ? conversation?.folderId ?? null : state.draftFolderId ?? null;
  const folder = folderId ? state.sidebar.folders.find(candidate => candidate.id === folderId) : undefined;
  return {
    convId: state.convId,
    convTitle: conversation?.title ?? null,
    folderId: folder ? folderId : null,
    folderName: folder?.name ?? null,
  };
}

/** /instructions: the picker, preselecting `scope` when given. */
export function openInstructionsPicker(state: RenderState, daemon: InstructionsDaemon, scope: InstructionScope = "conversation"): void {
  const target = currentInstructionsTarget(state);
  const picker: InstructionsPickerState = {
    target,
    texts: { conversation: null, folder: null, global: null },
    loadReqId: null,
    loaded: false,
    error: null,
    selection: Math.max(0, INSTRUCTION_SCOPES.indexOf(scope)),
  };
  // A draft has no stored instructions yet, only what /instructions queued for it.
  if (!target.convId) picker.texts.conversation = state.pendingSystemInstructions ?? "";
  picker.loadReqId = daemon.loadInstructions(target.convId, target.folderId);
  state.instructionsModal = { picker, editor: null };
}

/** The sidebar's AGENTS.md row: that folder's editor, without the picker. */
export function openFolderInstructionsEditor(state: RenderState, daemon: InstructionsDaemon, folderId: string): void {
  const folder = state.sidebar.folders.find(candidate => candidate.id === folderId);
  const target: InstructionsTarget = { convId: null, convTitle: null, folderId, folderName: folder?.name ?? null };
  const editor = createInstructionsEditor("folder", target, null);
  editor.loadReqId = daemon.loadInstructions(null, folderId);
  state.instructionsModal = { picker: null, editor };
}

export function closeInstructionsModal(state: RenderState): void {
  state.instructionsModal = null;
}

/** Leave the editor: back to the picker (refreshed from the daemon) or out. */
function closeEditor(state: RenderState, modal: InstructionsModalState, loader: Partial<InstructionsLoader> | null | undefined): void {
  if (!modal.picker) {
    state.instructionsModal = null;
    return;
  }
  modal.editor = null;
  if (loader?.loadInstructions) {
    modal.picker.loadReqId = loader.loadInstructions(modal.picker.target.convId, modal.picker.target.folderId);
  }
}

function openSelectedScope(modal: InstructionsModalState & { picker: InstructionsPickerState }): void {
  const picker = modal.picker;
  const scope = INSTRUCTION_SCOPES[picker.selection];
  if (!scope || !scopeAvailable(scope, picker.target)) return;
  const text = picker.texts[scope];
  // Wait for the text rather than open an editor that would overwrite it.
  if (text === null) return;
  modal.editor = createInstructionsEditor(scope, picker.target, text);
}

function movePickerSelection(picker: InstructionsPickerState, step: 1 | -1): void {
  let next = picker.selection;
  for (let i = 0; i < INSTRUCTION_SCOPES.length; i++) {
    next = (next + step + INSTRUCTION_SCOPES.length) % INSTRUCTION_SCOPES.length;
    if (scopeAvailable(INSTRUCTION_SCOPES[next], picker.target)) break;
  }
  picker.selection = next;
}

function handlePickerKey(key: KeyEvent, state: RenderState, modal: InstructionsModalState & { picker: InstructionsPickerState }): void {
  const picker = modal.picker;
  const char = key.type === "char" ? key.char : undefined;
  if (key.type === "escape" || char === "q") {
    state.instructionsModal = null;
    return;
  }
  if (char === "j" || key.type === "down" || key.type === "tab") movePickerSelection(picker, 1);
  else if (char === "k" || key.type === "up" || key.type === "backtab") movePickerSelection(picker, -1);
  else if (char === "g") picker.selection = 0;
  else if (char === "G") picker.selection = INSTRUCTION_SCOPES.length - 1;
  else if (key.type === "enter" || char === "l" || char === "e" || char === "i" || key.type === "right") openSelectedScope(modal);
  else if (char && /^[1-3]$/.test(char)) {
    const index = Number(char) - 1;
    if (scopeAvailable(INSTRUCTION_SCOPES[index], picker.target)) {
      picker.selection = index;
      openSelectedScope(modal);
    }
  }
}

function saveEditor(
  state: RenderState,
  modal: InstructionsModalState,
  editor: InstructionsEditorState,
  daemon: InstructionsDaemon,
  close: boolean,
  force: boolean,
): InstructionsKeyOutcome {
  if (editor.saving) {
    editor.notice = { text: "Still saving…", tone: "info" };
    return HANDLED;
  }
  if (!isInstructionsEditorDirty(editor) && !force) {
    if (close) closeEditor(state, modal, daemon);
    else editor.notice = { text: "No changes to save", tone: "info" };
    return HANDLED;
  }
  const text = editor.buffer.trim();
  const { target } = editor;
  let reqId: string;
  switch (editor.scope) {
    case "conversation":
      if (!target.convId) {
        // Like `/instructions <text>` in a draft: the conversation starts with them.
        state.instructionsModal = null;
        return text ? { type: "create_conversation", text } : HANDLED;
      }
      reqId = daemon.setSystemInstructions(target.convId, text);
      break;
    case "folder":
      if (!target.folderId) return HANDLED;
      reqId = daemon.setFolderInstructions(target.folderId, text);
      break;
    case "global":
      // Refused if config/system.md changed since it was loaded, unless forced (:w!).
      reqId = daemon.setGlobalInstructions(text, force ? undefined : editor.savedText.trim());
      break;
  }
  editor.saving = { reqId, text: editor.buffer, close };
  editor.notice = { text: "Saving…", tone: "info" };
  return HANDLED;
}

/** Keys while the modal is open: it owns the keyboard. */
export function handleInstructionsModalKey(
  key: KeyEvent,
  state: RenderState,
  daemon: InstructionsDaemon,
  onAsyncEdit?: () => void,
): InstructionsKeyOutcome {
  const modal = state.instructionsModal;
  if (!modal) return HANDLED;
  const editor = modal.editor;
  if (!editor) {
    if (modal.picker) handlePickerKey(key, state, modal as InstructionsModalState & { picker: InstructionsPickerState });
    return HANDLED;
  }
  const result = handleInstructionsEditorKey(key, editor, onAsyncEdit);
  switch (result.type) {
    case "handled":
      return HANDLED;
    case "close":
      closeEditor(state, modal, daemon);
      return HANDLED;
    case "save":
      return saveEditor(state, modal, editor, daemon, result.close, result.force);
  }
}

// ── Daemon answers ───────────────────────────────────────────────────

function settleSave(state: RenderState, modal: InstructionsModalState, editor: InstructionsEditorState, loader: Partial<InstructionsLoader> | null | undefined): void {
  const saving = editor.saving!;
  editor.saving = null;
  editor.savedText = saving.text;
  if (modal.picker) modal.picker.texts[editor.scope] = saving.text.trim();
  const cleared = !saving.text.trim();
  editor.notice = { text: cleared ? `${scopeLabel(editor.scope)} instructions cleared` : "Saved", tone: "success" };
  if (saving.close) closeEditor(state, modal, loader);
}

/** A newer text for `scope` arrived from elsewhere: show it unless it would overwrite edits. */
function applyRemoteText(modal: InstructionsModalState, scope: InstructionScope, matches: (target: InstructionsTarget) => boolean, text: string): void {
  if (modal.picker && matches(modal.picker.target)) modal.picker.texts[scope] = text;
  const editor = modal.editor;
  if (!editor || editor.scope !== scope || !matches(editor.target) || editor.saving || editor.loadReqId) return;
  if (text === editor.savedText.trim()) return;
  if (isInstructionsEditorDirty(editor)) {
    editor.notice = { text: "Changed elsewhere meanwhile; :w overwrites it", tone: "warning" };
    return;
  }
  setInstructionsEditorText(editor, text);
}

/**
 * Apply a daemon event to the modal. Returns true when the event was this
 * modal's answer and needs no other handling (its errors show in the modal).
 */
export function handleInstructionsEvent(state: RenderState, event: Event, loader?: Partial<InstructionsLoader> | null): boolean {
  const modal = state.instructionsModal;
  if (!modal) return false;
  const editor = modal.editor;
  const picker = modal.picker;
  const reqId = "reqId" in event ? event.reqId : undefined;

  switch (event.type) {
    case "instructions_loaded":
      if (picker && reqId && reqId === picker.loadReqId) {
        picker.loadReqId = null;
        picker.loaded = true;
        picker.error = null;
        picker.texts = {
          conversation: picker.target.convId ? event.conversation ?? "" : picker.texts.conversation ?? "",
          folder: picker.target.folderId ? event.folder ?? "" : null,
          global: event.global,
        };
        return true;
      }
      if (editor && reqId && reqId === editor.loadReqId) {
        const text = editor.scope === "conversation" ? event.conversation : editor.scope === "folder" ? event.folder : event.global;
        setInstructionsEditorText(editor, text ?? "");
        return true;
      }
      return false;

    case "ack":
      if (editor?.saving && reqId === editor.saving.reqId) {
        settleSave(state, modal, editor, loader);
        return true;
      }
      return false;

    case "system_instructions_updated":
      applyRemoteText(modal, "conversation", target => target.convId === event.convId, event.text);
      return false;

    case "folder_instructions_updated":
      if (editor?.saving && reqId === editor.saving.reqId) {
        settleSave(state, modal, editor, loader);
        return false;
      }
      applyRemoteText(modal, "folder", target => target.folderId === event.folderId, event.text);
      return false;

    case "global_instructions_updated":
      if (editor?.saving && reqId === editor.saving.reqId) {
        settleSave(state, modal, editor, loader);
        return true;
      }
      applyRemoteText(modal, "global", () => true, event.text);
      return true;

    case "error":
      if (editor?.saving && reqId === editor.saving.reqId) {
        editor.saving = null;
        const conflict = editor.scope === "global" && /changed since/i.test(event.message);
        editor.notice = { text: conflict ? "Global instructions changed elsewhere since you opened them; :w! overwrites" : event.message, tone: "error" };
        return true;
      }
      if (editor && reqId && reqId === editor.loadReqId) {
        state.instructionsModal = null;
        return false;
      }
      if (picker && reqId && reqId === picker.loadReqId) {
        picker.loadReqId = null;
        picker.error = event.message;
        return true;
      }
      return false;

    default:
      return false;
  }
}
