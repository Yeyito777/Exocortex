/**
 * /instructions controller: opens the picker or an editor, routes their keys,
 * and keeps both in step with the TUI's instructions store. Everything the
 * user does (open, switch scope, save, close) acts on the store at once; the
 * daemon is asked and written in the background (see ./store).
 */

import type { KeyEvent } from "../input";
import type { Event, ModelId, ProviderId, ToolInstructionsEdit } from "../protocol";
import { pushSystemMessage, type RenderState } from "../state";
import { theme } from "../theme";
import type { MacroDraft } from "../commands/macro";
import { sanitizePromptTextForInsertion } from "../prompttext";
import { handleInstructionsEditorKey } from "./editor";
import {
  applyToolsSaved,
  buildToolInstructionsDoc,
  changedToolBlocks,
  handleToolsViewKey,
  TOOLS_READ_ONLY_NOTICE,
  toolsSaveStatus,
  type ToolInstructionsDoc,
} from "./tools";
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
  GLOBAL_INSTRUCTIONS_KEY,
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

export interface InstructionsDaemon extends InstructionsLoader, Partial<ToolInstructionsLoader> {
  /** False while the link is down; saves then wait for a check after reconnecting. */
  readonly connected?: boolean;
  setSystemInstructions(convId: string, text: string): string;
  setFolderInstructions(folderId: string, text: string): string;
  setGlobalInstructions(text: string, expectedText?: string): string;
}

/** The daemon requests behind /instructions tools. */
export interface ToolInstructionsLoader {
  loadToolInstructions(convId: string | null, provider: ProviderId, model: ModelId): string;
  /** Write edited blocks back (answered with tool_instructions_saved, or an error). */
  saveToolInstructions?(convId: string | null, provider: ProviderId, model: ModelId | null, edits: ToolInstructionsEdit[], force: boolean): string;
}

export type InstructionsKeyOutcome =
  | { type: "handled" }
  /** :w in a macro editor: save the user macro (see usermacros/controller). */
  | { type: "save_macro"; draft: MacroDraft; text: string }
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
  if (scope === "global") editor.base = state.instructionsStore.globalBase;
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

/** An editor for one scope without the picker: shows what the TUI has, or waits for the daemon's text. */
function openScopeEditor(state: RenderState, daemon: InstructionsDaemon, scope: InstructionScope, target: InstructionsTarget): void {
  const reqId = loadInstructionsInto(state.instructionsStore, daemon, target.convId, target.folderId);
  if (scope === "conversation" && !target.convId) {
    // A draft: only what /instructions queued for it; saving creates the conversation.
    state.instructionsModal = { picker: null, editor: editorFor(state, scope, target, state.pendingSystemInstructions ?? "") };
    return;
  }
  const text = instructionsText(state.instructionsStore, scopeKey(scope, target)!);
  const editor = editorFor(state, scope, target, text);
  if (text === null) editor.loadReqId = reqId;
  state.instructionsModal = { picker: null, editor };
}

/** The sidebar folder menu's "Edit instructions": that folder's editor, without the picker. */
export function openFolderInstructionsEditor(state: RenderState, daemon: InstructionsDaemon, folderId: string): void {
  const folder = state.sidebar.folders.find(candidate => candidate.id === folderId);
  openScopeEditor(state, daemon, "folder", { convId: null, convTitle: null, folderId, folderName: folder?.name ?? null });
}

/** `/instructions conversation|folder|global`: that scope's editor for the open conversation, without the picker. */
export function openInstructionsScope(state: RenderState, daemon: InstructionsDaemon, scope: InstructionScope): void {
  const target = currentInstructionsTarget(state);
  if (!scopeAvailable(scope, target)) {
    pushSystemMessage(state, "No folder instructions here: this conversation is not in a folder. Move it into one, or use /instructions global.");
    return;
  }
  openScopeEditor(state, daemon, scope, target);
}

/** `/instructions tools`: what the model is told about each tool on this conversation's route; descriptions and hints edit in place. */
export function openToolInstructions(state: RenderState, daemon: ToolInstructionsLoader): void {
  const target = currentInstructionsTarget(state);
  const editor = createInstructionsEditor("global", target, "");
  editor.readOnly = true;
  editor.readOnlyNotice = TOOLS_READ_ONLY_NOTICE;
  editor.tools = buildToolInstructionsDoc({ provider: state.provider, model: state.model, route: "", internal: [], external: [] }).doc;
  editor.vim.mode = "normal";
  editor.loadReqId = daemon.loadToolInstructions(state.convId, state.provider, state.model);
  state.instructionsModal = { picker: null, editor };
}

/** /macro add or edit without "= text": write the macro's text in the editor. */
export function openMacroEditor(state: RenderState, draft: MacroDraft, text: string): void {
  const target: InstructionsTarget = { convId: null, convTitle: null, folderId: null, folderName: null };
  const editor = createInstructionsEditor("global", target, text);
  editor.macro = draft;
  state.instructionsModal = { picker: null, editor };
}

export function closeInstructionsModal(state: RenderState): void {
  state.instructionsModal = null;
}

/** Leave the editor (:q, :wq, :x): out of /instructions altogether, not back to the picker. */
function closeEditor(state: RenderState, _modal: InstructionsModalState): void {
  state.instructionsModal = null;
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
  // An older daemon's tools view can't be saved.
  if (editor.readOnly) return HANDLED;
  if (editor.tools) return saveToolsEditor(state, editor, editor.tools, daemon, close, force);
  if (editor.macro) {
    const text = editor.buffer.trim();
    if (!text) {
      editor.notice = { text: `Type what ${editor.macro.name} expands to first; :q closes`, tone: "warning" };
      return HANDLED;
    }
    const draft = editor.macro;
    if (close) state.instructionsModal = null;
    else {
      // Later :w replace what this one saved.
      editor.savedText = editor.buffer;
      editor.macro = { ...draft, create: false };
      editor.notice = { text: "Saved", tone: "success" };
    }
    return { type: "save_macro", draft, text };
  }
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

/** :w in /instructions tools: send the changed blocks; the answer says what was committed and pushed. */
function saveToolsEditor(
  state: RenderState,
  editor: InstructionsEditorState,
  doc: ToolInstructionsDoc,
  daemon: InstructionsDaemon,
  close: boolean,
  force: boolean,
): InstructionsKeyOutcome {
  if (doc.saving) {
    editor.notice = { text: "Still saving the last :w…", tone: "info" };
    return HANDLED;
  }
  const edits = changedToolBlocks(doc);
  if (edits.length === 0) {
    editor.savedText = editor.buffer;
    if (close) state.instructionsModal = null;
    else editor.notice = { text: "No changes to save", tone: "info" };
    return HANDLED;
  }
  if (!daemon.saveToolInstructions || daemon.connected === false) {
    editor.notice = { text: "Not saved: not connected to the daemon; :w tries again", tone: "error" };
    return HANDLED;
  }
  const reqId = daemon.saveToolInstructions(editor.target.convId, doc.provider as ProviderId, doc.model as ModelId | null, edits, force);
  doc.saving = { reqId, close, buffer: editor.buffer };
  editor.notice = { text: `Saving ${edits.length === 1 ? "1 block" : `${edits.length} blocks`}: write, commit, push…`, tone: "info" };
  return HANDLED;
}

/** The answer to a tools save: back into the editor that sent it, or into the chat once it closed. */
function handleToolsSaveAnswer(state: RenderState, event: Event): boolean {
  if (event.type !== "tool_instructions_saved" && event.type !== "error") return false;
  const editor = state.instructionsModal?.editor;
  const doc = editor?.tools;
  const mine = Boolean(doc?.saving && event.reqId && event.reqId === doc.saving.reqId);
  if (event.type === "error") {
    if (!mine) return false;
    editor!.notice = { text: `Not saved: ${event.message.replace(/\.$/, "")}`, tone: "error" };
    doc!.saving = null;
    return true;
  }
  const status = toolsSaveStatus(event);
  if (!mine) {
    // The editor was closed (or reopened) meanwhile.
    pushSystemMessage(state, `${status.ok ? "✓" : "✗"} Tool instructions ${status.text.replace(/^Saved/, "saved")}`, status.ok ? undefined : theme.error);
    return true;
  }
  const saving = doc!.saving!;
  doc!.saving = null;
  applyToolsSaved(doc!, event);
  // Clean again unless it was edited while saving.
  if (editor!.buffer === saving.buffer) editor!.savedText = editor!.buffer;
  if (saving.close && editor!.buffer === saving.buffer) {
    state.instructionsModal = null;
    pushSystemMessage(state, `${status.ok ? "✓" : "✗"} Tool instructions ${status.text.replace(/^Saved/, "saved")}`, status.ok ? undefined : theme.error);
    return true;
  }
  editor!.notice = { text: status.text, tone: status.ok ? "success" : "warning" };
  return true;
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
  if (handleToolsViewKey(key, editor)) return HANDLED;
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
  // The tools view is not one of the instruction scopes.
  if (editor.tools) return null;
  // A macro editor is not one of the instruction scopes.
  if (editor.macro) return null;
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
  if (handleToolsSaveAnswer(state, event)) return true;
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
    if (event.type === "tool_instructions_loaded" && editor.tools) {
      const { text, doc } = buildToolInstructionsDoc(event);
      setInstructionsEditorText(editor, text);
      editor.vim.mode = "normal";
      editor.tools = doc;
      editor.readOnly = !doc.editable;
      return true;
    }
    if (event.type === "instructions_loaded") {
      const key = editorKey(editor);
      setInstructionsEditorText(editor, (key && instructionsText(state.instructionsStore, key)) ?? "");
      restoreFailedSave(state, editor);
    }
  }

  // The base arrives with every load; an open Global editor shows the newest.
  const open = state.instructionsModal?.editor;
  if (open && editorKey(open) === GLOBAL_INSTRUCTIONS_KEY) open.base = state.instructionsStore.globalBase;

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
  const editor = state.instructionsModal?.editor;
  if (editor?.tools?.saving) {
    // Its answer is lost with the link; what was written shows when the view is opened again.
    editor.tools.saving = null;
    editor.notice = { text: "Connection lost while saving: reopen /instructions tools to see what was saved", tone: "warning" };
  }
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
