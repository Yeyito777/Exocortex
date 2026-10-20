/**
 * What the prompt shows while a `/macro …` command is typed: a colour per
 * part (red where it is wrong), dim ghost text for the parts still to come,
 * Tab completions, and a panel that explains the current part, previews the
 * macro and says what Enter will do. Pure functions of the parse; rendering
 * lives in ./render.
 */
import type { UserMacro } from "@exocortex/shared/user-macros";
import type { SlashCompletion } from "../slashsearch";
import { theme } from "../theme";
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
  /** The part holds the mistake the status explains. */
  wrong?: boolean;
}

export interface MacroPreviewLine {
  label: string;
  text: string;
  tone: "new" | "old" | "removed";
}

export interface MacroGuide {
  syntax: MacroSyntaxPart[];
  hint: string;
  preview: MacroPreviewLine[];
  /** What Enter does now, or why it can't. */
  status: { text: string; tone: "ready" | "pending" | "error" };
}

const UNDERLINE = "\x1b[4m";

export function roleColor(role: MacroPartRole): string {
  switch (role) {
    case "command":
    case "action":
    case "equals":
      return theme.command;
    case "name":
      return theme.accent + theme.bold;
    case "description":
      return theme.muted + theme.italic;
    case "expansion":
      return theme.success;
    case "extra":
      return theme.error;
  }
}

/** One colour per part; the part with the error is red and underlined. */
export function macroHighlightRanges(parse: MacroCommandParse): ColoredRange[] {
  const ranges: ColoredRange[] = [];
  const add = (role: MacroPartRole, p: { start: number; end: number } | null) => {
    if (!p || p.end <= p.start) return;
    const failed = parse.error && parse.error.role === role && parse.error.start === p.start;
    ranges.push({ start: p.start, end: p.end, color: failed ? theme.error + UNDERLINE : roleColor(role) });
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

function hintFor(parse: MacroCommandParse, context: MacroGuideContext): string {
  const name = parse.name?.text ?? "/name";
  switch (parse.action) {
    case null:
      return "Add, change or delete your own macros; Tab completes.";
    case "list":
      return "Shows your macros with their text, then the built-in ones.";
    case "undo":
      return context.lastDeleted ? `Brings back ${context.lastDeleted.name}, the macro you last deleted.` : "Nothing deleted yet in this session.";
    case "rm":
      return parse.focus === "name" || !parse.existing ? "Which of your macros to delete; Tab completes." : `Deletes ${name}; /macro undo brings it back.`;
    case "add":
      switch (parse.focus) {
        case "name":
        case "action":
          return "The name you'll type: / then letters, digits, - or _, e.g. /brief.";
        case "description":
          return "Optional: a few words shown in autocomplete. Then = and the text it expands to.";
        default:
          return `What ${name} expands to, anywhere in a message. Shift+Enter adds a line.`;
      }
    case "edit":
      switch (parse.focus) {
        case "name":
        case "action":
          return "Which of your macros to change; Tab completes.";
        case "description":
          return "= new text replaces it; words before = replace the description. Enter alone opens the editor.";
        default:
          return `The new text for ${name}. Shift+Enter adds a line.`;
      }
  }
}

function previewFor(parse: MacroCommandParse): MacroPreviewLine[] {
  const name = parse.name?.text;
  if (!name) return [];
  const existing = parse.existing;
  switch (parse.action) {
    case "add":
      return parse.expansion && !parse.error ? [{ label: name, text: expansionPreview(parse.expansion.text), tone: "new" }] : [];
    case "edit":
      if (!existing) return [];
      if (!parse.expansion) return [{ label: "now", text: expansionPreview(existing.expansion), tone: "old" }];
      return [
        { label: "new", text: expansionPreview(parse.expansion.text), tone: "new" },
        { label: "was", text: expansionPreview(existing.expansion), tone: "old" },
      ];
    case "rm":
      return existing ? [{ label: name, text: expansionPreview(existing.expansion), tone: "removed" }] : [];
    default:
      return [];
  }
}

function statusFor(parse: MacroCommandParse, context: MacroGuideContext): MacroGuide["status"] {
  if (parse.error) return { text: `✗ ${parse.error.message}`, tone: "error" };
  if (parse.incomplete) return { text: parse.incomplete, tone: "pending" };
  const name = parse.name?.text ?? "";
  switch (parse.action) {
    case "list": return { text: "Enter lists them.", tone: "ready" };
    case "undo": return context.lastDeleted
      ? { text: `Enter restores ${context.lastDeleted.name}.`, tone: "ready" }
      : { text: "Nothing to restore.", tone: "pending" };
    case "rm": return { text: `Enter deletes ${name}; /macro undo restores it.`, tone: "ready" };
    case "add":
      return parse.expansion
        ? { text: `Enter saves ${name}.`, tone: "ready" }
        : { text: `Enter opens the editor for ${name}'s text; or type = and the text.`, tone: "ready" };
    case "edit":
      return parse.expansion
        ? { text: `Enter saves the new text for ${name}.`, tone: "ready" }
        : { text: `Enter opens ${name} in the editor.`, tone: "ready" };
    default:
      return parse.actionPart
        ? { text: "Pick what to do.", tone: "pending" }
        : { text: "Enter lists your macros; or pick what to do.", tone: "ready" };
  }
}

/** The panel's content for a /macro prompt; null for any other prompt. */
export function macroGuide(buffer: string, cursor: number, context: MacroGuideContext): MacroGuide | null {
  const parse = parseMacroCommand(buffer, cursor, context);
  if (!parse) return null;
  return { syntax: syntaxFor(parse), hint: hintFor(parse, context), preview: previewFor(parse), status: statusFor(parse, context) };
}
