/**
 * /macro — add, edit, delete and list your own macros while the app runs.
 *
 *   /macro add /brief = Answer in one short sentence.
 *   /macro add /brief Answer briefly = Answer in one short sentence.
 *   /macro edit /brief = new text          (/macro edit /brief opens the editor)
 *   /macro rm /brief                       (/macro undo brings it back)
 *   /macro [list]
 *
 * The syntax and its live help are in ../usermacros/parse and ../usermacros/guide.
 * Macros live in the connected daemon's config (daemon/src/user-macros.ts);
 * ../usermacros/store applies changes at once and confirms them in the background.
 */
import type { UserMacro } from "@exocortex/shared/user-macros";
import { BUILT_IN_MACRO_LIST, getUserMacros, isBuiltInMacroName } from "../macros";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage, type RenderState } from "../state";
import { theme } from "../theme";
import { expansionPreview } from "../usermacros/guide";
import { parseMacroCommand, type MacroParseContext } from "../usermacros/parse";
import type { CommandResult, SlashCommand } from "./types";

/** A macro whose text is being written in the editor. */
export interface MacroDraft {
  name: string;
  description?: string;
  /** False when editing an existing macro. */
  create: boolean;
}

function fail(state: RenderState, message: string): CommandResult {
  // The prompt is kept so the red part can be fixed.
  pushSystemMessage(state, `✗ ${message}`, theme.error);
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

/** Yours with their text; built-ins by name, since autocomplete describes them. */
function formatList(context: MacroParseContext, cols: number): string {
  const user = getUserMacros();
  const width = Math.max(0, ...user.map(macro => macro.name.length));
  const textWidth = Math.max(20, Math.min(90, cols - width - 12));
  const lines = [user.length === 0 ? "Your macros: none yet. /macro add /name = text makes one." : `Your macros (${user.length}):`];
  for (const macro of user) {
    const shadowed = isBuiltInMacroName(macro.name) || context.isReservedName(macro.name);
    const summary = macro.description
      ? `${macro.description} · ${expansionPreview(macro.expansion, Math.max(12, textWidth - macro.description.length - 3))}`
      : expansionPreview(macro.expansion, textWidth);
    lines.push(`  ${macro.name.padEnd(width)}  ${shadowed ? `${summary}  [inactive: a built-in uses this name]` : summary}`);
  }
  lines.push(`Built-in macros (${BUILT_IN_MACRO_LIST.length}):`);
  lines.push(...wrapNames(BUILT_IN_MACRO_LIST.map(macro => macro.name), Math.max(30, Math.min(100, cols - 8))));
  return lines.join("\n");
}

export function createMacroCommand(context: () => MacroParseContext): SlashCommand {
  return {
    name: "/macro",
    description: "Add, edit, delete or list your own macros",
    handler: (text, state) => {
      const ctx = context();
      const parse = parseMacroCommand(text, text.length, ctx);
      if (!parse) return { type: "handled" };
      if (parse.error) return fail(state, parse.error.message);
      if (parse.incomplete && !(parse.action === "undo")) return fail(state, parse.incomplete);
      const retryText = text;

      switch (parse.action) {
        case null:
        case "list":
          pushSystemMessage(state, formatList(ctx, state.cols));
          clearPrompt(state);
          return { type: "handled" };

        case "undo": {
          const deleted = state.lastDeletedMacro;
          if (!deleted) return fail(state, "No deleted macro to restore.");
          if (getUserMacros().some(macro => macro.name === deleted.name)) return fail(state, `${deleted.name} exists again; nothing to restore.`);
          clearPrompt(state);
          return { type: "restore_user_macro", macro: deleted };
        }

        case "rm":
          clearPrompt(state);
          return { type: "delete_user_macro", name: parse.name!.text, retryText };

        case "add":
        case "edit": {
          const name = parse.name!.text;
          const description = parse.description?.text ?? (parse.action === "edit" ? parse.existing?.description : undefined);
          const create = parse.action === "add";
          clearPrompt(state);
          if (!parse.expansion) {
            const draft: MacroDraft = { name, create, ...(description ? { description } : {}) };
            return { type: "open_macro_editor", draft, text: parse.existing?.expansion ?? "" };
          }
          const macro: UserMacro = { name, expansion: parse.expansion.text, ...(description ? { description } : {}) };
          return { type: "save_user_macro", macro, create, retryText };
        }
      }
    },
  };
}
