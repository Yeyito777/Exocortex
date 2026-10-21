/**
 * What the prompt shows while a `/macro …` command is typed. The line keeps
 * the TUI's normal slash-command highlighting, plus red on a wrong part; dim
 * ghost text after the cursor names the parts still to come; and the normal
 * autocomplete popup shows the Tab completions or, with nothing to complete,
 * one row: the error, what the macro expands to, or the part to type next.
 * Pure functions of the parse.
 */
import type { UserMacro } from "@exocortex/shared/user-macros";
import type { SlashCompletion } from "../slashsearch";
import { theme } from "../theme";
import { MACRO_SUBCOMMANDS, parseMacroCommand, type MacroCommandParse, type MacroParseContext } from "./parse";

export interface MacroGuideContext extends MacroParseContext {
  /** The macro /macro undo would restore. */
  lastDeleted: UserMacro | null;
}

export interface ColoredRange {
  start: number;
  end: number;
  color: string;
}

/** The next part to type, as the popup row names and explains it. */
export interface MacroNextPart {
  text: string;
  help: string;
}

/** Why the line is wrong, or what the macro expands to. */
export type MacroGuideDetail =
  | { kind: "error"; text: string }
  | { kind: "note"; text: string }
  | { kind: "preview"; label: string; text: string; tone: "new" | "removed" };

export interface MacroGuide {
  next: MacroNextPart | null;
  /** Shown instead of `next`; an error wins over Tab completions too. */
  detail: MacroGuideDetail | null;
}

/** The wrong part, in red; the rest of the line keeps the normal command highlighting. */
export function macroErrorRange(parse: MacroCommandParse): ColoredRange | null {
  const error = parse.error;
  return error && error.end > error.start ? { start: error.start, end: error.end, color: theme.error } : null;
}

/** A macro's text on one line, for previews and completion rows. */
export function expansionPreview(text: string, max = 72): string {
  const lines = text.split("\n");
  const first = lines[0]!.trim();
  const more = lines.length > 1 ? ` (+${lines.length - 1} line${lines.length === 2 ? "" : "s"})` : "";
  return (first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first) + more;
}

function matchingSubcommands(prefix: string): typeof MACRO_SUBCOMMANDS {
  return MACRO_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix) || (sub.action === "rm" && "delete".startsWith(prefix) && prefix.length > 0));
}

function matchingMacros(parse: MacroCommandParse, context: MacroParseContext): readonly UserMacro[] {
  const prefix = parse.name?.text ?? "";
  return context.userMacros.filter(macro => macro.name.startsWith(prefix));
}

/** Tab completions for the part at the cursor; each fills the prompt from "/macro" on. */
export function macroCompletions(buffer: string, cursor: number, context: MacroParseContext): SlashCompletion[] {
  const parse = parseMacroCommand(buffer, cursor, context);
  if (!parse || cursor !== buffer.length) return [];
  const head = (end: number) => buffer.slice(parse.command.start, end);
  if (parse.action === null) {
    const lead = parse.actionPart ? head(parse.actionPart.start) : `${head(parse.command.end)} `;
    return matchingSubcommands(parse.actionPart?.text ?? "").map(sub => ({
      name: sub.name,
      desc: sub.desc,
      insertText: `${lead}${sub.name} `,
    }));
  }
  if ((parse.action === "edit" || parse.action === "rm") && parse.focus === "name") {
    const lead = parse.name ? head(parse.name.start) : `${head(parse.actionPart!.end)} `;
    return matchingMacros(parse, context).map(macro => ({
      name: macro.name,
      desc: macro.description ? `${macro.description} · ${expansionPreview(macro.expansion, 48)}` : expansionPreview(macro.expansion, 60),
      insertText: `${lead}${macro.name} `,
    }));
  }
  return [];
}

/** Dim text after the cursor naming the parts still to type. */
export function macroGhostText(buffer: string, cursor: number, context: MacroParseContext): string {
  if (cursor !== buffer.length) return "";
  const parse = parseMacroCommand(buffer, cursor, context);
  if (!parse || parse.error) return "";
  const spaced = (text: string) => (/\s$/.test(buffer) ? text : ` ${text}`);
  const textFor = (action: string) => action === "edit" ? "= new text" : "= text";
  if (!parse.actionPart) return spaced("add /name = text");
  if (parse.action === null) {
    const sub = matchingSubcommands(parse.actionPart.text)[0];
    if (!sub || !sub.name.startsWith(parse.actionPart.text)) return "";
    const rest = sub.name.slice(parse.actionPart.text.length);
    const after = sub.action === "add" || sub.action === "edit" ? ` /name ${textFor(sub.action)}` : sub.action === "rm" ? " /name" : "";
    return rest + after;
  }
  if (parse.action === "list" || parse.action === "undo") return "";
  if (!parse.name) {
    // edit and rm: what Tab would insert.
    const first = parse.action === "add" ? undefined : context.userMacros[0];
    if (first) return spaced(parse.action === "edit" ? `${first.name} ${textFor("edit")}` : first.name);
    return spaced(parse.action === "rm" ? "/name" : `/name [description] ${textFor(parse.action)}`);
  }
  if (parse.focus === "name" && (parse.action === "edit" || parse.action === "rm")) {
    const match = context.userMacros.find(macro => macro.name.startsWith(parse.name!.text) && macro.name !== parse.name!.text);
    if (match && !parse.existing) return match.name.slice(parse.name.text.length) + (parse.action === "edit" ? ` ${textFor("edit")}` : "");
  }
  if (parse.action === "rm") return "";
  if (!parse.equals) {
    return spaced(parse.description || parse.action === "edit" ? textFor(parse.action) : `[description] ${textFor(parse.action)}`);
  }
  if (!parse.expansion) return spaced(parse.action === "edit" ? "new text" : `text ${parse.name.text} expands to`);
  return "";
}

function nextFor(parse: MacroCommandParse): MacroNextPart | null {
  const name = parse.name?.text;
  const textHelp = name ? `what ${name} expands to` : "what it expands to";
  switch (parse.action) {
    case null:
      return { text: "add | edit | rm | list | undo", help: "what to do" };
    case "add":
    case "edit": {
      const edit = parse.action === "edit";
      if (!name || parse.focus === "name" || parse.focus === "action") {
        return { text: "/name", help: edit ? "one of your macros" : "the macro's name, e.g. /brief" };
      }
      if (parse.equals) return { text: edit ? "new text" : "text", help: textHelp };
      if (parse.description) return { text: edit ? "= new text" : "= text", help: textHelp };
      return edit
        ? { text: "= new text", help: "or Enter to open it in the editor" }
        : { text: "[description] = text", help: `optional description, then ${textHelp}` };
    }
    case "rm":
      return name ? null : { text: "/name", help: "one of your macros" };
    default:
      return null;
  }
}

function detailFor(parse: MacroCommandParse, context: MacroGuideContext): MacroGuideDetail | null {
  if (parse.error) return { kind: "error", text: parse.error.message };
  const name = parse.name?.text;
  switch (parse.action) {
    case "add":
    case "edit":
      // Only once there is text after "=": before that the ghost text says what comes next.
      return name && parse.expansion ? { kind: "preview", label: name, text: expansionPreview(parse.expansion.text), tone: "new" } : null;
    case "rm":
      return name && parse.existing ? { kind: "preview", label: name, text: expansionPreview(parse.existing.expansion), tone: "removed" } : null;
    case "undo":
      return context.lastDeleted
        ? { kind: "preview", label: context.lastDeleted.name, text: expansionPreview(context.lastDeleted.expansion), tone: "new" }
        : { kind: "note", text: "Nothing deleted to restore." };
    default:
      return null;
  }
}

/** The panel's content for a /macro prompt; null for any other prompt. */
export function macroGuide(buffer: string, cursor: number, context: MacroGuideContext): MacroGuide | null {
  const parse = parseMacroCommand(buffer, cursor, context);
  if (!parse) return null;
  return { next: nextFor(parse), detail: detailFor(parse, context) };
}

export interface MacroPopupRow {
  name: string;
  desc: string;
  descColor?: string;
}

/** The popup's one row when there is nothing to complete: the error, the preview, or the next part. */
export function macroPopupRow(guide: MacroGuide): MacroPopupRow | null {
  const detail = guide.detail;
  if (detail?.kind === "error") return { name: "✗", desc: detail.text, descColor: theme.error };
  if (detail?.kind === "preview") return { name: detail.label, desc: `→ ${detail.text}` };
  if (detail?.kind === "note") return { name: "", desc: detail.text };
  return guide.next ? { name: guide.next.text, desc: guide.next.help } : null;
}
