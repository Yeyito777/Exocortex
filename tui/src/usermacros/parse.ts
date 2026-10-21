/**
 * Parse a `/macro …` prompt as it is being typed.
 *
 *   /macro add /name [description] = text     save in one line
 *   /macro add /name [description]            Enter opens the editor for the text
 *   /macro edit /name [description] = text    replace; without "=" the editor opens
 *   /macro rm /name · /macro undo · /macro [list]
 *
 * Everything after the first "=" is the macro's text, so the text itself may
 * contain "=" and, with Shift+Enter, several lines. The parse keeps every
 * part's buffer offsets, so the prompt can colour each part, flag errors in
 * place and explain the next part while the user types.
 */
import {
  MAX_USER_MACRO_DESCRIPTION_LENGTH,
  MAX_USER_MACRO_EXPANSION_LENGTH,
  userMacroNameError,
  type UserMacro,
} from "@exocortex/shared/user-macros";

export type MacroAction = "list" | "add" | "edit" | "rm" | "undo";

export interface MacroSubcommand {
  name: string;
  action: MacroAction;
  desc: string;
}

/** Popup order. `delete` is accepted for `rm` but not offered. */
export const MACRO_SUBCOMMANDS: readonly MacroSubcommand[] = [
  { name: "add", action: "add", desc: "Save a new macro: /macro add /name = text" },
  { name: "edit", action: "edit", desc: "Change one of yours: = new text, or Enter for the editor" },
  { name: "rm", action: "rm", desc: "Delete one of yours (/macro undo restores it)" },
  { name: "list", action: "list", desc: "Show your macros and the built-in ones" },
  { name: "undo", action: "undo", desc: "Restore the macro you last deleted" },
];

const ACTION_ALIASES: Record<string, MacroAction> = { delete: "rm" };

export type MacroPartRole = "command" | "action" | "name" | "description" | "equals" | "expansion" | "extra";

export interface MacroPart {
  start: number;
  /** Exclusive. */
  end: number;
  text: string;
}

export interface MacroIssue {
  role: MacroPartRole;
  start: number;
  end: number;
  message: string;
}

/** What the user is typing now, which the hint and ghost text describe. */
export type MacroFocus = "action" | "name" | "description" | "expansion" | "done";

export interface MacroCommandParse {
  /** "/macro" itself. */
  command: MacroPart;
  actionPart: MacroPart | null;
  /** Null while missing, unknown or only partly typed. */
  action: MacroAction | null;
  name: MacroPart | null;
  description: MacroPart | null;
  equals: MacroPart | null;
  /** The text after "=", trimmed; null without "=" or when nothing follows it. */
  expansion: MacroPart | null;
  /** Words a subcommand does not take. */
  extra: MacroPart | null;
  /** The existing macro `edit`/`rm` names (or `add` clashes with). */
  existing: UserMacro | null;
  focus: MacroFocus;
  /** A definite mistake, shown in red; Enter refuses to run. */
  error: MacroIssue | null;
  /** Nothing is wrong, but Enter cannot run it yet (e.g. no name). */
  incomplete: string | null;
}

export interface MacroParseContext {
  userMacros: readonly UserMacro[];
  isBuiltInMacro(name: string): boolean;
  /** Command and inline-command names a macro may not take. */
  isReservedName(name: string): boolean;
  /**
   * The user typed a moment ago: hold back an error in the part that ends at
   * the cursor, so "/go" does not flash red on the way to "/gold".
   */
  holdTypingErrors?: boolean;
}

const COMMAND = "/macro";

/** True for prompt text the /macro command owns, including its multi-line form. */
export function isMacroCommandText(text: string): boolean {
  return /^\s*\/macro(?:\s|$)/.test(text);
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n";
}

function skipSpace(buffer: string, pos: number): number {
  while (pos < buffer.length && isSpace(buffer[pos])) pos++;
  return pos;
}

function part(buffer: string, start: number, end: number): MacroPart {
  return { start, end, text: buffer.slice(start, end) };
}

/** The non-space run starting at `pos`, stopping early at `stop`. */
function word(buffer: string, pos: number, stop?: string): MacroPart | null {
  let end = pos;
  while (end < buffer.length && !isSpace(buffer[end]) && buffer[end] !== stop) end++;
  return end > pos ? part(buffer, pos, end) : null;
}

/** The span of `buffer[from, to)` without surrounding whitespace, or null if blank. */
function trimmed(buffer: string, from: number, to: number): MacroPart | null {
  let start = from;
  let end = to;
  while (start < end && isSpace(buffer[start])) start++;
  while (end > start && isSpace(buffer[end - 1])) end--;
  return end > start ? part(buffer, start, end) : null;
}

/** Parse `buffer` (a whole prompt starting with /macro) with the cursor at `cursor`. */
export function parseMacroCommand(buffer: string, cursor: number, context: MacroParseContext): MacroCommandParse | null {
  const result = parseFully(buffer, cursor, context);
  if (result?.error && context.holdTypingErrors && result.error.end === cursor) result.error = null;
  return result;
}

function parseFully(buffer: string, cursor: number, context: MacroParseContext): MacroCommandParse | null {
  if (!isMacroCommandText(buffer)) return null;
  const commandStart = skipSpace(buffer, 0);
  const result: MacroCommandParse = {
    command: part(buffer, commandStart, commandStart + COMMAND.length),
    actionPart: null,
    action: null,
    name: null,
    description: null,
    equals: null,
    expansion: null,
    extra: null,
    existing: null,
    focus: "action",
    error: null,
    incomplete: null,
  };
  const atEnd = (p: MacroPart) => cursor === p.end;
  const issue = (role: MacroPartRole, p: MacroPart, message: string) => {
    result.error ??= { role, start: p.start, end: p.end, message };
  };

  // ── Action ──
  const actionPart = word(buffer, skipSpace(buffer, result.command.end));
  // `/macro` alone lists: action stays null with no action part.
  if (!actionPart) return result;
  result.actionPart = actionPart;
  const action = ACTION_ALIASES[actionPart.text]
    ?? MACRO_SUBCOMMANDS.find(sub => sub.name === actionPart.text)?.action
    ?? null;
  if (!action) {
    result.focus = "action";
    const partial = atEnd(actionPart) && [...MACRO_SUBCOMMANDS.map(sub => sub.name), "delete"].some(name => name.startsWith(actionPart.text));
    if (partial) result.incomplete = "Pick what to do.";
    else issue("action", actionPart, `Unknown action “${actionPart.text}”: use add, edit, rm, list or undo.`);
    return result;
  }
  result.action = action;
  const afterAction = skipSpace(buffer, actionPart.end);

  if (action === "list" || action === "undo") {
    result.focus = "done";
    const rest = trimmed(buffer, actionPart.end, buffer.length);
    if (rest) {
      result.extra = rest;
      issue("extra", rest, `/macro ${action} takes nothing else.`);
    }
    return result;
  }

  // ── Name ──
  const name = afterAction > actionPart.end ? word(buffer, afterAction, "=") : null;
  if (!name) {
    result.focus = cursor > actionPart.end || afterAction > actionPart.end ? "name" : "action";
    result.incomplete = action === "add" ? "Name the macro, e.g. /brief." : "Which macro?";
    if (action === "add" && buffer[afterAction] === "=") {
      issue("equals", part(buffer, afterAction, afterAction + 1), "Name the macro before =, e.g. /macro add /brief = text.");
    }
    return result;
  }
  result.name = name;
  result.focus = "name";
  const typingName = atEnd(name);
  const existing = context.userMacros.find(macro => macro.name === name.text) ?? null;
  result.existing = existing;
  const nameError = userMacroNameError(name.text);
  if (nameError) {
    // "/" alone is a name still being typed.
    if (typingName && name.text === "/") result.incomplete = "Name the macro, e.g. /brief.";
    else issue("name", name, nameError);
  } else if (action === "add") {
    if (context.isBuiltInMacro(name.text)) issue("name", name, `${name.text} is a built-in macro; pick another name.`);
    else if (context.isReservedName(name.text)) issue("name", name, `${name.text} is a built-in command; pick another name.`);
    else if (existing) issue("name", name, `${name.text} already exists; /macro edit ${name.text} changes it.`);
  } else if (!existing) {
    const typingPrefix = typingName && context.userMacros.some(macro => macro.name.startsWith(name.text));
    if (typingPrefix) result.incomplete = "Which macro?";
    else if (context.isBuiltInMacro(name.text)) issue("name", name, `${name.text} is built in and can't be ${action === "rm" ? "deleted" : "edited"}.`);
    else issue("name", name, context.userMacros.length
      ? `No macro named ${name.text}; /macro list shows yours.`
      : `No macro named ${name.text}: you have none yet.`);
  }

  if (action === "rm") {
    result.focus = cursor > name.end ? "done" : "name";
    const rest = trimmed(buffer, name.end, buffer.length);
    if (rest) {
      result.extra = rest;
      issue("extra", rest, "/macro rm takes just the macro's name.");
    }
    return result;
  }

  // ── Description and text ──
  const equalsAt = buffer.indexOf("=", name.end);
  const descriptionEnd = equalsAt === -1 ? buffer.length : equalsAt;
  const description = trimmed(buffer, name.end, descriptionEnd);
  result.description = description;
  if (cursor > name.end) result.focus = "description";
  if (description) {
    if (description.text.includes("\n")) {
      issue("description", description, "The description must fit on one line: put = before the text.");
    } else if (description.text.length > MAX_USER_MACRO_DESCRIPTION_LENGTH) {
      issue("description", description, `Descriptions are at most ${MAX_USER_MACRO_DESCRIPTION_LENGTH} characters.`);
    }
  }
  if (equalsAt === -1) return result;

  result.equals = part(buffer, equalsAt, equalsAt + 1);
  if (cursor > equalsAt) result.focus = "expansion";
  const expansion = trimmed(buffer, equalsAt + 1, buffer.length);
  result.expansion = expansion;
  if (!expansion) {
    // Just typed "=": the text comes next.
    if (cursor >= buffer.trimEnd().length) result.incomplete = `Type what ${name.text} expands to.`;
    else issue("equals", result.equals, `Type what ${name.text} expands to after =.`);
  } else if (expansion.text.length > MAX_USER_MACRO_EXPANSION_LENGTH) {
    issue("expansion", expansion, `Macro text is limited to ${MAX_USER_MACRO_EXPANSION_LENGTH.toLocaleString("en-US")} characters.`);
  }
  return result;
}
