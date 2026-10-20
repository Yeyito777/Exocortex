/**
 * /instructions controller: opens the picker or an editor, routes their keys,
 * and keeps both in step with the TUI's instructions store. Everything the
 * user does (open, switch scope, save, close) acts on the store at once; the
 * daemon is asked and written in the background (see ./store).
 */

import type { KeyEvent } from "../input";
import type { Event } from "../protocol";
import { pushSystemMessage, type RenderState } from "../state";
import { theme } from "../theme";
import { sanitizePromptTextForInsertion } from "../prompttext";
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
import {
  applyInstructionsStoreEvent,
  hasPendingInstructionsSave,
  instructionsConnectionLost as markConnectionLost,
  instructionsFailure,
  instructionsKey,
  instructionsReconnected as checkWaitingSaves,
  instructionsText,
  loadInstructionsInto,
  prefetchInstructions,
  resetInstructionsStore,
  saveInstructions,
  takeInstructionsFailure,
  type InstructionsFailure,
  type InstructionsStoreChange,
  type InstructionsStoreDaemon,
} from "./store";

export interface InstructionsLoader {
  loadInstructions(convId: string | null, folderId: string | null): string;
}

export interface InstructionsDaemon extends InstructionsLoader {
  /** False while the link is down; saves then wait for a check after reconnecting. */
  readonly connected?: boolean;
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

/** The store key for a scope of this target; null when it has none (a draft, no folder). */
function scopeKey(scope: InstructionScope, target: InstructionsTarget): string | null {
  return instructionsKey(scope, scope === "conversation" ? target.convId : scope === "folder" ? target.folderId : null);
}

/** Refresh the picker's rows from the store. */
function syncPicker(state: RenderState, picker: InstructionsPickerState): void {
  const store = state.instructionsStore;
  for (const scope of INSTRUCTION_SCOPES) {
    const key = scopeKey(scope, picker.target);
    if (scope === "conversation" && !picker.target.convId) {
      // A draft has no stored instructions yet, only what /instructions queued for it.
      picker.texts.conversation = state.pendingSystemInstructions ?? "";
      picker.failures.conversation = null;
      continue;
    }
    picker.texts[scope] = key ? instructionsText(store, key) : null;
    picker.failures[scope] = key ? instructionsFailure(store, key)?.message ?? null : null;
  }
}

/** /instructions: the picker, preselecting `scope` when given. Shows what the TUI has and checks it in the background. */
export function openInstructionsPicker(state: RenderState, daemon: InstructionsDaemon, scope: InstructionScope = "conversation"): void {
  const target = currentInstructionsTarget(state);
  const picker: InstructionsPickerState = {
    target,
    texts: { conversation: null, folder: null, global: null },
    failures: { conversation: null, folder: null, global: null },
    loadReqId: null,
    error: null,
    selection: Math.max(0, INSTRUCTION_SCOPES.indexOf(scope)),
  };
  picker.loadReqId = loadInstructionsInto(state.instructionsStore, daemon, target.convId, target.folderId);
  syncPicker(state, picker);
  state.instructionsModal = { picker, editor: null };
}

function failureNotice(scope: InstructionScope, failure: InstructionsFailure): string {
  if (failure.conflict) return `${scopeLabel(scope)} instructions changed elsewhere since you opened them; :w! overwrites`;
  return `Not saved: ${failure.message.replace(/\.$/, "")}; :w tries again`;
}

/** An editor for `scope` with the text the TUI has, or a failed save's text to try again. */
function editorFor(state: RenderState, scope: InstructionScope, target: InstructionsTarget, text: string | null): InstructionsEditorState {
  const editor = createInstructionsEditor(scope, target, text);
  if (text !== null) restoreFailedSave(state, editor);
  return editor;
}

function restoreFailedSave(state: RenderState, editor: InstructionsEditorState): void {
  const key = editorKey(editor);
  const failure = key ? takeInstructionsFailure(state.instructionsStore, key) : null;
  if (!failure) return;
  editor.buffer = sanitizePromptTextForInsertion(failure.text);
  editor.vim.mode = "normal";
  editor.notice = { text: failureNotice(editor.scope, failure), tone: "error" };
}

/** The sidebar folder menu's "Edit instructions": that folder's editor, without the picker. */
export function openFolderInstructionsEditor(state: RenderState, daemon: InstructionsDaemon, folderId: string): void {
  const folder = state.sidebar.folders.find(candidate => candidate.id === folderId);
  const target: InstructionsTarget = { convId: null, convTitle: null, folderId, folderName: folder?.name ?? null };
  const text = instructionsText(state.instructionsStore, instructionsKey("folder", folderId)!);
  const reqId = loadInstructionsInto(state.instructionsStore, daemon, null, folderId);
  const editor = editorFor(state, "folder", target, text);
  if (text === null) editor.loadReqId = reqId;
  state.instructionsModal = { picker: null, editor };
}

export function closeInstructionsModal(state: RenderState): void {
  state.instructionsModal = null;
}

/** Leave the editor: back to the picker, or out. */
function closeEditor(state: RenderState, modal: InstructionsModalState): void {
  if (!modal.picker) {
    state.instructionsModal = null;
    return;
  }
  modal.editor = null;
  syncPicker(state, modal.picker);
}

function openSelectedScope(state: RenderState, modal: InstructionsModalState & { picker: InstructionsPickerState }): void {
  const picker = modal.picker;
  const scope = INSTRUCTION_SCOPES[picker.selection];
  if (!scope || !scopeAvailable(scope, picker.target)) return;
  const text = picker.texts[scope];
  // Wait for the text rather than open an editor that would overwrite it.
  if (text === null) return;
  modal.editor = editorFor(state, scope, picker.target, text);
  syncPicker(state, picker);
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
  else if (key.type === "enter" || char === "l" || char === "e" || char === "i" || key.type === "right") openSelectedScope(state, modal);
  else if (char && /^[1-3]$/.test(char)) {
    const index = Number(char) - 1;
    if (scopeAvailable(INSTRUCTION_SCOPES[index], picker.target)) {
      picker.selection = index;
      openSelectedScope(state, modal);
    }
  }
}

/** Save at once: the editor is clean and the picker shows the text; the daemon write follows. */
function saveEditor(
  state: RenderState,
  modal: InstructionsModalState,
  editor: InstructionsEditorState,
  daemon: InstructionsDaemon,
  close: boolean,
  force: boolean,
): InstructionsKeyOutcome {
  if (!isInstructionsEditorDirty(editor) && !force) {
    if (close) closeEditor(state, modal);
    else editor.notice = { text: "No changes to save", tone: "info" };
    return HANDLED;
  }
  const text = editor.buffer.trim();
  const { target } = editor;
  if (editor.scope === "conversation" && !target.convId) {
    // Like `/instructions <text>` in a draft: the conversation starts with them.
    state.instructionsModal = null;
    return text ? { type: "create_conversation", text } : HANDLED;
  }
  const id = editor.scope === "conversation" ? target.convId : editor.scope === "folder" ? target.folderId : null;
  if (editor.scope !== "global" && !id) return HANDLED;
  // The base guards against writing over an edit made elsewhere since this one began.
  saveInstructions(state.instructionsStore, daemon, editor.scope, id, text, editor.savedText.trim(), force);
  editor.savedText = editor.buffer;
  editor.notice = { text: text ? "Saved" : `${scopeLabel(editor.scope)} instructions cleared`, tone: "success" };
  if (close) closeEditor(state, modal);
  else if (modal.picker) syncPicker(state, modal.picker);
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
      closeEditor(state, modal);
      return HANDLED;
    case "save":
      return saveEditor(state, modal, editor, daemon, result.close, result.force);
  }
}

// ── Daemon answers ───────────────────────────────────────────────────

function editorKey(editor: InstructionsEditorState): string | null {
  return scopeKey(editor.scope, editor.target);
}

/** The scope's text changed (elsewhere, or a check came back): show it unless it would overwrite edits. */
function applyRemoteText(state: RenderState, editor: InstructionsEditorState, key: string): void {
  if (editor.loadReqId || hasPendingInstructionsSave(state.instructionsStore, key)) return;
  const text = instructionsText(state.instructionsStore, key);
  if (text === null || text === editor.savedText.trim()) return;
  if (isInstructionsEditorDirty(editor)) {
    editor.notice = { text: "Changed elsewhere meanwhile; :w overwrites", tone: "warning" };
    return;
  }
  setInstructionsEditorText(editor, text);
}

function failureLabel(state: RenderState, key: string, scope: InstructionScope, id: string | null): string {
  if (scope === "conversation") {
    const title = state.sidebar.conversations.find(conv => conv.id === id)?.title?.trim();
    return title ? `Conversation instructions for “${title}”` : "Conversation instructions";
  }
  if (scope === "folder") {
    const name = state.sidebar.folders.find(folder => folder.id === id)?.name;
    return name ? `Folder instructions for ${name}/` : "Folder instructions";
  }
  return key === "global" ? "Global instructions" : `${scopeLabel(scope)} instructions`;
}

/** A save failed: back into the open editor, onto the picker row, or a notice in the chat. */
function showFailure(state: RenderState, change: Extract<InstructionsStoreChange, { type: "failed" }>): void {
  const modal = state.instructionsModal;
  const editor = modal?.editor;
  if (editor && editorKey(editor) === change.key) {
    // The editor still holds the text (or newer): it is unsaved again.
    takeInstructionsFailure(state.instructionsStore, change.key);
    editor.savedText = sanitizePromptTextForInsertion(instructionsText(state.instructionsStore, change.key) ?? "");
    editor.notice = { text: failureNotice(editor.scope, change.failure), tone: "error" };
    return;
  }
  const picker = modal?.picker;
  const shownOnPicker = picker && !editor && INSTRUCTION_SCOPES.some(scope => scopeKey(scope, picker.target) === change.key);
  if (shownOnPicker) return;
  const { scope, id } = change.save;
  pushSystemMessage(
    state,
    `✗ ${failureLabel(state, change.key, scope, id)} were not saved: ${change.failure.message.replace(/\.$/, "")}. Open /instructions to get the text back.`,
    theme.error,
  );
}

/**
 * Apply a daemon event to the store and the modal. Returns true when the
 * event was an answer to /instructions and needs no other handling.
 */
export function handleInstructionsEvent(state: RenderState, event: Event, daemon?: InstructionsStoreDaemon | null): boolean {
  const { changes, consumed } = applyInstructionsStoreEvent(state.instructionsStore, daemon ?? {}, event);
  const modal = state.instructionsModal;
  const reqId = "reqId" in event ? event.reqId : undefined;
  // A failed check shows on the picker rather than in the chat.
  const pickerLoad = Boolean(modal?.picker && reqId && reqId === modal.picker.loadReqId);
  if (pickerLoad) {
    modal!.picker!.loadReqId = null;
    modal!.picker!.error = event.type === "error" ? event.message : null;
  }
  const editor = modal?.editor;
  if (editor?.loadReqId && reqId === editor.loadReqId) {
    if (event.type === "error") {
      // Nothing to edit: close, and let the error show in the chat.
      state.instructionsModal = null;
      return false;
    }
    if (event.type === "instructions_loaded") {
      const key = editorKey(editor);
      setInstructionsEditorText(editor, (key && instructionsText(state.instructionsStore, key)) ?? "");
      restoreFailedSave(state, editor);
    }
  }

  for (const change of changes) {
    if (change.type === "failed") showFailure(state, change);
    else if (change.type === "text" && state.instructionsModal?.editor && editorKey(state.instructionsModal.editor) === change.key) {
      applyRemoteText(state, state.instructionsModal.editor, change.key);
    }
  }
  if (state.instructionsModal?.picker) syncPicker(state, state.instructionsModal.picker);
  return consumed || pickerLoad;
}

// ── Connection ───────────────────────────────────────────────────────

/** The link dropped: saves in flight wait for a check after reconnecting. */
export function instructionsConnectionLost(state: RenderState): void {
  markConnectionLost(state.instructionsStore);
}

/** Connected again: check and send the saves that waited. */
export function instructionsReconnected(state: RenderState, daemon: InstructionsDaemon): void {
  checkWaitingSaves(state.instructionsStore, daemon);
}

/** Switched to another daemon: forget its texts; unsaved text stays recoverable where it can be. */
export function instructionsRouteSwitched(state: RenderState): void {
  for (const change of resetInstructionsStore(state.instructionsStore)) {
    if (change.type === "failed") showFailure(state, change);
  }
}

/** Fetch in the background what /instructions would show for the open conversation or draft. */
export function prefetchCurrentInstructions(state: RenderState, daemon: InstructionsDaemon): void {
  const target = currentInstructionsTarget(state);
  prefetchInstructions(state.instructionsStore, daemon, target.convId, target.folderId);
}
