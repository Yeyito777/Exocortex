/**
 * What the prompt shows while a `/macro …` command is typed: a colour per
 * part (red where it is wrong), dim ghost text for the parts still to come,
 * and a small panel above the prompt: the syntax with the current part lit,
 * then one detail row (the error, Tab completions, or what the macro expands
 * to). Pure functions of the parse; rendering lives in ./render.
 */
import type { UserMacro } from "@exocortex/shared/user-macros";
import type { SlashCompletion } from "../slashsearch";
import { macroStyle, type MacroStyle } from "./styles";
import { MACRO_SUBCOMMANDS, parseMacroCommand, type MacroCommandParse, type MacroParseContext, type MacroPartRole } from "./parse";

export interface MacroGuideContext extends MacroParseContext {
  /** The macro /macro undo would restore. */
  lastDeleted: UserMacro | null;
}

export interface ColoredRange {
  start: number;
  end: number;
  color: string;
}

export interface MacroSyntaxPart {
  text: string;
  /** The part being typed now. */
  active: boolean;
  optional?: boolean;
  /** The part holds the mistake the error row explains. */
  wrong?: boolean;
}

/** The row under the syntax: why the line is wrong, or what the macro expands to. */
export type MacroGuideDetail =
  | { kind: "error"; text: string }
  | { kind: "note"; text: string }
  | { kind: "preview"; label: string; text: string; tone: "new" | "removed" };

export interface MacroGuide {
  syntax: MacroSyntaxPart[];
  /** Shown unless Tab completions take the row (an error always wins). */
  detail: MacroGuideDetail | null;
}

/** A colour per part as the current style has it (see ./styles); the part with the error is red. */
export function macroHighlightRanges(parse: MacroCommandParse, style: MacroStyle = macroStyle()): ColoredRange[] {
  const ranges: ColoredRange[] = [];
  const add = (role: MacroPartRole, p: { start: number; end: number } | null) => {
    if (!p || p.end <= p.start) return;
    const failed = parse.error && parse.error.role === role && parse.error.start === p.start;
    const color = failed ? style.errorColor : style.partColor(role);
    if (color) ranges.push({ start: p.start, end: p.end, color });
  };
  add("command", parse.command);
  add("action", parse.actionPart);
  add("name", parse.name);
  add("description", parse.description);
  add("equals", parse.equals);
  add("expansion", parse.expansion);
  add("extra", parse.extra);
  return ranges;
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

function syntaxFor(parse: MacroCommandParse): MacroSyntaxPart[] {
  const parts = syntaxParts(parse);
  const wrong = parse.error?.role;
  const index = wrong === "action" ? (parts.length > 1 ? 1 : 0)
    : wrong === "name" ? 1
      : wrong === "description" ? 2
        : wrong === "equals" || wrong === "expansion" ? parts.length - 1
          : wrong === "extra" ? parts.length - 1 : -1;
  if (index >= 0 && parts[index]) parts[index] = { ...parts[index]!, wrong: true };
  return parts;
}

function syntaxParts(parse: MacroCommandParse): MacroSyntaxPart[] {
  const at = (focus: MacroCommandParse["focus"]) => parse.focus === focus;
  switch (parse.action) {
    case "add":
    case "edit":
      return [
        { text: `/macro ${parse.action}`, active: false },
        { text: "/name", active: at("name") },
        { text: "[description]", active: at("description"), optional: true },
        { text: parse.action === "edit" ? "= new text" : "= text", active: at("expansion") || (at("description") && !parse.description) },
      ];
    case "rm":
      return [{ text: "/macro rm", active: false }, { text: "/name", active: at("name") }];
    case "list":
    case "undo":
      return [{ text: `/macro ${parse.action}`, active: false }];
    default:
      return [{ text: "/macro", active: false }, { text: "add | edit | rm | list | undo", active: true }];
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
  return { syntax: syntaxFor(parse), detail: detailFor(parse, context) };
}
