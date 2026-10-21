/**
 * Client side of user macros: run /macro's results through the optimistic
 * store (./store), keep the macro registry (../macros) in step with what the
 * store shows, and say what happened: a notice at once, and another if the
 * daemon later refuses a change (which rolls it back).
 */
import { normalizeUserMacro, type UserMacro } from "@exocortex/shared/user-macros";
import type { MacroDraft } from "../commands/macro";
import type { CommandResult } from "../commands/types";
import { openMacroEditor } from "../instructions/controller";
import { getUserMacros, isBuiltInMacroName, setUserMacros } from "../macros";
import { replacePrompt } from "../promptstate";
import type { Event } from "../protocol";
import { pushSystemMessage, type RenderState } from "../state";
import { theme } from "../theme";
import { expansionPreview, type MacroGuideContext } from "./guide";
import type { MacroParseContext } from "./parse";
import {
  receiveUserMacros,
  rejectUserMacroChange,
  resetUserMacroStore,
  shownUserMacros,
  submitUserMacroChange,
  userMacrosConnectionLost as markConnectionLost,
  type PendingUserMacroChange,
  type UserMacroFailure,
  type UserMacroStoreDaemon,
} from "./store";

/** The daemon methods macros need; absent on test doubles and older transports. */
export interface UserMacroDaemon {
  readonly connected?: boolean;
  saveUserMacro?(macro: UserMacro, create: boolean): string | null;
  deleteUserMacro?(name: string): string | null;
}

function storeDaemon(daemon: UserMacroDaemon): UserMacroStoreDaemon {
  return {
    get connected() { return daemon.connected; },
    saveUserMacro: (macro, create) => daemon.saveUserMacro?.(macro, create) ?? null,
    deleteUserMacro: name => daemon.deleteUserMacro?.(name) ?? null,
  };
}

function syncRegistry(state: RenderState): void {
  setUserMacros(shownUserMacros(state.macroStore));
}

/** What the parser and the prompt's help need to know about this TUI's macros. */
export function macroGuideContext(state: RenderState, base: MacroParseContext): MacroGuideContext {
  return { ...base, lastDeleted: state.lastDeletedMacro };
}

export function defaultMacroParseContext(isReservedName: (name: string) => boolean): MacroParseContext {
  return { userMacros: getUserMacros(), isBuiltInMacro: isBuiltInMacroName, isReservedName };
}

function submit(state: RenderState, daemon: UserMacroDaemon, pending: Omit<PendingUserMacroChange, "reqId" | "uncertain">): void {
  submitUserMacroChange(state.macroStore, storeDaemon(daemon), pending);
  syncRegistry(state);
}

function saveMacro(state: RenderState, daemon: UserMacroDaemon, raw: UserMacro, create: boolean, retryText?: string): boolean {
  let macro: UserMacro;
  try {
    macro = normalizeUserMacro(raw);
  } catch (error) {
    pushSystemMessage(state, `✗ ${error instanceof Error ? error.message : String(error)}`, theme.error);
    if (retryText) giveBack(state, retryText);
    return false;
  }
  submit(state, daemon, { change: { kind: "save", macro, create }, label: "save", retryText });
  if (state.lastDeletedMacro?.name === macro.name) state.lastDeletedMacro = null;
  pushSystemMessage(
    state,
    `✓ ${create ? "Saved" : "Updated"} ${macro.name} → ${expansionPreview(macro.expansion)}${create ? `  ·  type ${macro.name} anywhere in a message` : ""}`,
    theme.success,
  );
  return true;
}

/** Carry out a /macro result; other command results are left alone. */
export function runUserMacroCommand(state: RenderState, daemon: UserMacroDaemon, result: CommandResult): void {
  switch (result.type) {
    case "save_user_macro":
      saveMacro(state, daemon, result.macro, result.create, result.retryText);
      break;
    case "delete_user_macro": {
      const macro = getUserMacros().find(candidate => candidate.name === result.name);
      submit(state, daemon, { change: { kind: "delete", name: result.name }, label: "delete", retryText: result.retryText });
      if (macro) state.lastDeletedMacro = macro;
      pushSystemMessage(state, `✓ Deleted ${result.name}. /macro undo brings it back.`, theme.success);
      break;
    }
    case "restore_user_macro":
      submit(state, daemon, { change: { kind: "save", macro: result.macro, create: true }, label: "restore" });
      state.lastDeletedMacro = null;
      pushSystemMessage(state, `✓ Restored ${result.macro.name} → ${expansionPreview(result.macro.expansion)}`, theme.success);
      break;
    case "open_macro_editor":
      openMacroEditor(state, result.draft, result.text);
      break;
  }
}

/** :w in the macro editor. */
export function saveMacroFromEditor(state: RenderState, daemon: UserMacroDaemon, draft: MacroDraft, text: string): void {
  saveMacro(state, daemon, { name: draft.name, expansion: text, ...(draft.description ? { description: draft.description } : {}) }, draft.create);
}

/** Put a failed /macro command back in an empty prompt so it can be fixed and sent again. */
function giveBack(state: RenderState, text: string): void {
  if (state.inputBuffer.trim() || state.instructionsModal) return;
  replacePrompt(state, text);
}

function reportFailure(state: RenderState, failure: UserMacroFailure): void {
  const { pending } = failure;
  const name = pending.change.kind === "save" ? pending.change.macro.name : pending.change.name;
  const message = /^Unknown command: (?:save|delete)_user_macro$/.test(failure.message)
    ? "this daemon predates /macro; update it first"
    : failure.message.replace(/\.$/, "");
  const what = pending.label === "delete" ? "deleted" : pending.label === "restore" ? "restored" : "saved";
  if (pending.label === "delete" && state.lastDeletedMacro?.name === name) state.lastDeletedMacro = null;
  if (pending.label === "restore" && pending.change.kind === "save") state.lastDeletedMacro = pending.change.macro;
  const back = pending.retryText && !state.inputBuffer.trim() && !state.instructionsModal;
  pushSystemMessage(state, `✗ ${name} was not ${what}: ${message}. Undone${back ? "; your command is back in the prompt" : ""}.`, theme.error);
  if (back) giveBack(state, pending.retryText!);
}

export function handleUserMacrosEvent(state: RenderState, daemon: UserMacroDaemon, event: Extract<Event, { type: "user_macros" }>): void {
  const macros = Array.isArray(event.macros) ? event.macros : [];
  const failures = receiveUserMacros(state.macroStore, storeDaemon(daemon), macros, event.reqId);
  syncRegistry(state);
  for (const failure of failures) reportFailure(state, failure);
}

/** A refused macro change rolls back with a notice. Returns false for other errors. */
export function handleUserMacroError(state: RenderState, event: Extract<Event, { type: "error" }>): boolean {
  if (!event.reqId) return false;
  const failure = rejectUserMacroChange(state.macroStore, event.reqId, event.message);
  if (!failure) return false;
  syncRegistry(state);
  reportFailure(state, failure);
  return true;
}

/** The link dropped: changes in flight are checked against the list sent after reconnecting. */
export function userMacrosConnectionLost(state: RenderState): void {
  markConnectionLost(state.macroStore);
}

/** Another daemon: its macros replace these; unconfirmed changes are reported. */
export function userMacrosRouteSwitched(state: RenderState): void {
  const failures = resetUserMacroStore(state.macroStore);
  state.lastDeletedMacro = null;
  syncRegistry(state);
  for (const failure of failures) reportFailure(state, failure);
}
