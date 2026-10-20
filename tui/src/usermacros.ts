/**
 * Client side of user macros: sending /macro changes to the daemon, the
 * prompt-line draft, and turning the daemon's answers into feedback.
 *
 * The daemon's `user_macros` event is the only source of the list; this TUI
 * never edits it locally, so every connected TUI shows the same macros.
 */
import { normalizeUserMacro, type UserMacro } from "@exocortex/shared/user-macros";
import type { MacroDraft } from "./commands/macro";
import type { CommandResult } from "./commands/types";
import { setUserMacros } from "./macros";
import { clearPrompt, replacePrompt } from "./promptstate";
import type { Event } from "./protocol";
import { pushSystemMessage, type RenderState } from "./state";
import { theme } from "./theme";

export interface UserMacroActions {
  saveUserMacro(macro: UserMacro, create: boolean): string | null;
  deleteUserMacro(name: string): string | null;
}

export interface PendingMacroRequest {
  kind: "save" | "delete" | "restore";
  name: string;
  /** What to put back in the prompt if a save fails. */
  draft?: MacroDraft;
  text?: string;
}

function track(state: RenderState, reqId: string | null, request: PendingMacroRequest): void {
  if (reqId) state.pendingMacroRequests.set(reqId, request);
}

function saveDraft(state: RenderState, daemon: UserMacroActions, draft: MacroDraft, expansion: string): boolean {
  let macro: UserMacro;
  try {
    macro = normalizeUserMacro({ name: draft.name, description: draft.description, expansion });
  } catch (error) {
    pushSystemMessage(state, `✗ ${error instanceof Error ? error.message : String(error)}`, theme.error);
    return false;
  }
  track(state, daemon.saveUserMacro(macro, draft.create), { kind: "save", name: macro.name, draft, text: expansion });
  return true;
}

/** Send a /macro command's change to the daemon; other results need nothing. */
export function runUserMacroCommand(state: RenderState, daemon: UserMacroActions, result: CommandResult): void {
  switch (result.type) {
    case "save_user_macro":
      saveDraft(state, daemon, result.draft, result.expansion);
      break;
    case "delete_user_macro":
      track(state, daemon.deleteUserMacro(result.name), { kind: "delete", name: result.name });
      break;
    case "restore_user_macro":
      track(state, daemon.saveUserMacro(result.macro, true), { kind: "restore", name: result.macro.name });
      break;
  }
}

/**
 * Enter while a macro draft is open: save the prompt as its text, or cancel
 * when the prompt is empty. The draft closes only once the save is sent.
 */
export function submitMacroDraft(state: RenderState, daemon: UserMacroActions, hasImages: boolean): void {
  const draft = state.macroDraft!;
  const text = state.inputBuffer.trim();
  if (hasImages) {
    pushSystemMessage(state, "Macros are text only; remove the image to save.", theme.warning);
    return;
  }
  if (!text) {
    cancelMacroDraft(state);
    return;
  }
  if (!saveDraft(state, daemon, draft, text)) return;
  state.macroDraft = null;
  clearPrompt(state);
}

export function cancelMacroDraft(state: RenderState): void {
  const draft = state.macroDraft;
  if (!draft) return;
  state.macroDraft = null;
  clearPrompt(state);
  pushSystemMessage(state, `Cancelled ${draft.create ? "new macro" : "editing"} ${draft.name}.`, theme.muted);
}

/** The label shown in the prompt's top border while drafting. */
export function macroDraftLabel(draft: MacroDraft): string {
  const what = draft.create ? `New macro ${draft.name}` : `Editing ${draft.name}`;
  const desc = draft.description ? ` (${draft.description})` : "";
  return `${what}${desc} · type its text · Enter saves · empty Enter cancels`;
}

function feedback(request: PendingMacroRequest | undefined, change: NonNullable<Extract<Event, { type: "user_macros" }>["change"]>): string {
  const { name } = change.macro;
  if (request?.kind === "restore") return `✓ Restored macro ${name}.`;
  switch (change.action) {
    case "created": return `✓ Saved macro ${name}. Type ${name} anywhere in a message to use it.`;
    case "updated": return `✓ Updated macro ${name}.`;
    case "deleted": return `✓ Deleted macro ${name}. /macro undo brings it back.`;
  }
}

export function handleUserMacrosEvent(state: RenderState, event: Extract<Event, { type: "user_macros" }>): void {
  setUserMacros(Array.isArray(event.macros) ? event.macros : []);
  if (!event.reqId || !event.change) return;
  const request = state.pendingMacroRequests.get(event.reqId);
  state.pendingMacroRequests.delete(event.reqId);
  if (event.change.action === "deleted") state.lastDeletedMacro = event.change.macro;
  else if (state.lastDeletedMacro?.name === event.change.macro.name) state.lastDeletedMacro = null;
  pushSystemMessage(state, feedback(request, event.change), theme.success);
}

/** Report a rejected macro change and give a failed save's text back. Returns false for other errors. */
export function handleUserMacroError(state: RenderState, event: Extract<Event, { type: "error" }>): boolean {
  const request = event.reqId ? state.pendingMacroRequests.get(event.reqId) : undefined;
  if (!request) return false;
  state.pendingMacroRequests.delete(event.reqId!);
  const message = /^Unknown command: (?:save|delete)_user_macro$/.test(event.message)
    ? "this daemon predates /macro; update it first."
    : event.message;
  const verb = request.kind === "delete" ? "delete" : request.kind === "restore" ? "restore" : "save";
  pushSystemMessage(state, `✗ Could not ${verb} macro ${request.name}: ${message}`, theme.error);
  if (request.draft && request.text !== undefined && !state.macroDraft && !state.inputBuffer.trim()) {
    state.macroDraft = request.draft;
    replacePrompt(state, request.text);
  }
  return true;
}

/** Another daemon is about to answer: its macros replace these. */
export function resetUserMacros(state: RenderState): void {
  setUserMacros([]);
  state.pendingMacroRequests.clear();
  state.lastDeletedMacro = null;
}
