/**
 * /macro — list, add, edit and delete user macros while the app runs.
 *
 *   /macro [list]                     every macro, yours first
 *   /macro add /name [description]    the prompt becomes the macro's text;
 *                                     Enter saves, Enter on an empty prompt cancels
 *   /macro edit /name [description]   same, prefilled with the current text
 *   /macro rm /name                   delete (alias: delete); /macro undo restores
 *
 * Lines after the first line of an add/edit save at once, so a whole macro
 * can also be typed in one multi-line prompt. Macros live in the connected
 * daemon's config (daemon/src/user-macros.ts), so every TUI of that daemon
 * sees a change immediately.
 */
import { userMacroNameError, type UserMacro } from "@exocortex/shared/user-macros";
import { BUILT_IN_MACRO_LIST, getUserMacros, isBuiltInMacroName, userMacroSummary } from "../macros";
import { clearPrompt, replacePrompt } from "../promptstate";
import { pushSystemMessage, type RenderState } from "../state";
import { theme } from "../theme";
import type { CommandResult, CompletionItem, SlashCommand } from "./types";

/** A macro being typed into the prompt line. */
export interface MacroDraft {
  name: string;
  description?: string;
  /** False when editing an existing macro. */
  create: boolean;
}

const SUBCOMMANDS: CompletionItem[] = [
  { name: "list", desc: "Show your macros and the built-in ones" },
  { name: "add", desc: "Add a macro: /macro add /name [description]" },
  { name: "edit", desc: "Change one of your macros" },
  { name: "rm", desc: "Delete one of your macros", aliases: ["delete"] },
  { name: "undo", desc: "Restore the macro you last deleted" },
];

/** True for prompt text the /macro command owns, including its multi-line form. */
export function isMacroCommandText(text: string): boolean {
  return /^\/macro(?:\s|$)/.test(text);
}

function findUserMacro(name: string): UserMacro | undefined {
  return getUserMacros().find(macro => macro.name === name);
}

function userMacroCompletions(): CompletionItem[] {
  return getUserMacros().map(macro => ({ name: macro.name, desc: userMacroSummary(macro) }));
}

function fail(state: RenderState, message: string, keepPrompt = true): CommandResult {
  pushSystemMessage(state, `✗ ${message}`, theme.error);
  if (!keepPrompt) clearPrompt(state);
  return { type: "handled" };
}

/** Names packed into indented lines of at most `width` columns. */
function wrapNames(names: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const name of names) {
    if (line && line.length + 2 + name.length > width) {
      lines.push(`  ${line}`);
      line = "";
    }
    line = line ? `${line}  ${name}` : name;
  }
  if (line) lines.push(`  ${line}`);
  return lines;
}

/** Yours with their descriptions; built-ins by name, since autocomplete describes them. */
function formatList(reserved: ReadonlySet<string>, cols: number): string {
  const user = getUserMacros();
  const width = Math.max(0, ...user.map(macro => macro.name.length));
  const lines = [user.length === 0 ? "Your macros: none yet." : `Your macros (${user.length}):`];
  for (const macro of user) {
    const shadowed = isBuiltInMacroName(macro.name) || reserved.has(macro.name);
    const summary = userMacroSummary(macro);
    lines.push(`  ${macro.name.padEnd(width)}  ${shadowed ? `${summary}  [inactive: a built-in uses this name]` : summary}`);
  }
  lines.push(`Built-in macros (${BUILT_IN_MACRO_LIST.length}):`);
  lines.push(...wrapNames(BUILT_IN_MACRO_LIST.map(macro => macro.name), Math.max(30, Math.min(100, cols - 8))));
  lines.push("/macro add /name [description] · /macro edit /name · /macro rm /name");
  return lines.join("\n");
}

/** Begin typing a macro's text in the prompt line. */
function startDraft(state: RenderState, draft: MacroDraft, text: string): CommandResult {
  state.macroDraft = draft;
  state.autocomplete = null;
  replacePrompt(state, text);
  return { type: "handled" };
}

function parseHeader(text: string): { words: string[]; description: string; body: string } {
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  const body = newline < 0 ? "" : text.slice(newline + 1).trim();
  const words = header.trim().split(/\s+/);
  // Keep the description's own spacing: everything after the third word.
  const description = header.trim().replace(/^\S+\s+\S+\s+\S+\s*/, "").trim();
  return { words, description: words.length > 3 ? description : "", body };
}

export function createMacroCommand(reservedNames: () => Iterable<string>): SlashCommand {
  return {
    name: "/macro",
    description: "Add, edit, delete or list your own macros",
    args: SUBCOMMANDS,
    getArgs: () => {
      const names = userMacroCompletions();
      return { "/macro edit": names, "/macro rm": names, "/macro delete": names };
    },
    handler: (text, state) => {
      const reserved = new Set(reservedNames());
      const { words, description, body } = parseHeader(text);
      const sub = words[1] ?? "list";
      const name = words[2] ?? "";

      switch (sub) {
        case "list": {
          pushSystemMessage(state, formatList(reserved, state.cols));
          clearPrompt(state);
          return { type: "handled" };
        }

        case "add": {
          const nameError = userMacroNameError(name);
          if (nameError) return fail(state, nameError);
          if (isBuiltInMacroName(name)) return fail(state, `${name} is a built-in macro; pick another name.`);
          if (reserved.has(name)) return fail(state, `${name} is a built-in command; pick another name.`);
          if (findUserMacro(name)) return fail(state, `${name} already exists. Use /macro edit ${name} to change it.`);
          const draft: MacroDraft = { name, create: true, ...(description ? { description } : {}) };
          if (body) {
            clearPrompt(state);
            return { type: "save_user_macro", draft, expansion: body };
          }
          return startDraft(state, draft, "");
        }

        case "edit": {
          if (!name) return fail(state, "Which macro? /macro edit /name");
          const existing = findUserMacro(name);
          if (!existing) {
            return fail(state, isBuiltInMacroName(name)
              ? `${name} is built in and can't be edited. Add your own under another name.`
              : `No macro named ${name}. /macro list shows yours.`);
          }
          const nextDescription = description || existing.description;
          const draft: MacroDraft = { name, create: false, ...(nextDescription ? { description: nextDescription } : {}) };
          if (body) {
            clearPrompt(state);
            return { type: "save_user_macro", draft, expansion: body };
          }
          return startDraft(state, draft, existing.expansion);
        }

        case "rm":
        case "delete": {
          if (!name) return fail(state, `Which macro? /macro ${sub} /name`);
          if (!findUserMacro(name)) {
            return fail(state, isBuiltInMacroName(name)
              ? `${name} is built in and can't be deleted.`
              : `No macro named ${name}. /macro list shows yours.`);
          }
          clearPrompt(state);
          return { type: "delete_user_macro", name };
        }

        case "undo": {
          const deleted = state.lastDeletedMacro;
          if (!deleted) return fail(state, "No deleted macro to restore.", false);
          if (findUserMacro(deleted.name)) return fail(state, `${deleted.name} exists again; nothing to restore.`, false);
          clearPrompt(state);
          return { type: "restore_user_macro", macro: deleted };
        }

        default:
          return fail(state, `Unknown /macro action "${sub}". Try /macro list, add, edit, rm or undo.`);
      }
    },
  };
}
