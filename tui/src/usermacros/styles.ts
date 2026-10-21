/**
 * How a /macro line looks while it is typed. Every visual choice lives here so
 * the alternatives can be compared on one branch and the chosen one kept:
 *
 *   v3  colour per part, syntax panel above the prompt (the current default)
 *   A   monochrome: weight and dim only; red is the one colour, for errors
 *   B   one accent (the name); the syntax row is a quiet dim hint
 *   C   inline only: no rows above the prompt; hints, previews and errors
 *       are ghost text after the cursor; Tab uses the normal popup
 *   D   native: looks like any other slash command; the normal autocomplete
 *       popup carries completions, previews and errors as its own rows
 *
 * Dev flag: EXOCORTEX_MACRO_STYLE=v3|A|B|C|D.
 */
import { theme } from "../theme";
import type { MacroGuide, MacroGuideDetail, MacroSyntaxPart } from "./guide";
import type { MacroPartRole } from "./parse";

export type MacroStyleId = "v3" | "A" | "B" | "C" | "D";
export const MACRO_STYLE_IDS: readonly MacroStyleId[] = ["v3", "A", "B", "C", "D"];

const UNDERLINE = "\x1b[4m";

export interface MacroStyle {
  id: MacroStyleId;
  /** Prompt colour for a part; "" keeps the default text colour. */
  partColor(role: MacroPartRole): string;
  /** Prompt colour for the part with the error. */
  errorColor: string;
  /** Where help goes above the prompt: the macro panel, the normal popup, or nowhere. */
  surface: "panel" | "popup" | "inline";
  /** Panel styles (surface "panel"). */
  syntaxColor(part: MacroSyntaxPart): string;
  previewLabelColor(detail: Extract<MacroGuideDetail, { kind: "preview" }>): string;
  previewTextColor: string;
  markerColor: string;
}

const panelDefaults = {
  previewTextColor: theme.text,
  markerColor: theme.accent,
};

function v3(): MacroStyle {
  return {
    id: "v3",
    ...panelDefaults,
    surface: "panel",
    errorColor: theme.error + UNDERLINE,
    partColor: role => {
      switch (role) {
        case "command": case "action": case "equals": return theme.command;
        case "name": return theme.accent + theme.bold;
        case "description": return theme.goal + theme.italic;
        case "expansion": return theme.success;
        case "extra": return theme.error;
      }
    },
    syntaxColor: part => part.wrong ? theme.error + theme.bold + UNDERLINE
      : part.active ? theme.accent + theme.bold + UNDERLINE
        : part.optional ? theme.muted + theme.italic : theme.muted,
    previewLabelColor: detail => detail.tone === "new" ? theme.success : theme.error,
  };
}

/** Text weight and dim only; red marks mistakes and nothing else. */
function monochromeParts(role: MacroPartRole): string {
  switch (role) {
    case "name": return theme.bold;
    case "description": case "equals": return theme.dim;
    case "extra": return theme.error;
    default: return "";
  }
}

function styleA(): MacroStyle {
  return {
    id: "A",
    surface: "panel",
    errorColor: theme.error,
    partColor: monochromeParts,
    syntaxColor: part => part.wrong ? theme.error : part.active ? theme.text + theme.bold : theme.dim,
    previewLabelColor: () => theme.dim,
    previewTextColor: theme.text,
    markerColor: theme.text,
  };
}

function styleB(): MacroStyle {
  return {
    id: "B",
    surface: "panel",
    errorColor: theme.error,
    partColor: role => {
      switch (role) {
        case "name": return theme.accent;
        case "description": return theme.dim;
        case "extra": return theme.error;
        default: return "";
      }
    },
    // A quiet hint: all dim, the current part merely undimmed.
    syntaxColor: part => part.wrong ? theme.error : part.active ? theme.text : theme.dim,
    previewLabelColor: () => theme.accent,
    previewTextColor: theme.muted,
    markerColor: theme.accent,
  };
}

function styleC(): MacroStyle {
  return { ...styleA(), id: "C", surface: "inline" };
}

function styleD(): MacroStyle {
  return {
    ...styleA(),
    id: "D",
    surface: "popup",
    // Like the arguments of any other slash command.
    partColor: role => {
      switch (role) {
        case "command": case "action": case "name": return theme.command;
        case "description": return theme.dim;
        case "extra": return theme.error;
        default: return "";
      }
    },
  };
}

const BUILDERS: Record<MacroStyleId, () => MacroStyle> = { v3, A: styleA, B: styleB, C: styleC, D: styleD };

let override: MacroStyleId | null = null;

/** Pin a style (tests, demos); null goes back to the environment. */
export function setMacroStyle(id: MacroStyleId | null): void {
  override = id;
}

export function macroStyleId(): MacroStyleId {
  if (override) return override;
  const env = process.env.EXOCORTEX_MACRO_STYLE?.trim();
  return env && (MACRO_STYLE_IDS as readonly string[]).includes(env) ? env as MacroStyleId : "v3";
}

/** Built per call: theme colours change when the theme does. */
export function macroStyle(): MacroStyle {
  return BUILDERS[macroStyleId()]();
}

// ── Inline (C) and popup (D) help ────────────────────────────────

/** The text C puts after the cursor: an error, else what comes next, else a preview. */
export function inlineMacroHint(guide: MacroGuide, nextParts: string): { text: string; color: string } | null {
  const detail = guide.detail;
  if (detail?.kind === "error") return { text: `  ✗ ${detail.text}`, color: theme.error + theme.dim };
  if (nextParts) return { text: nextParts, color: theme.dim + theme.italic };
  if (detail?.kind === "preview") {
    // An add already shows its text on the line; previews help for rm, edit and undo.
    const typedText = guide.syntax.some(part => part.text.startsWith("=") && part.active);
    if (typedText) return null;
    return { text: `  → ${detail.text}`, color: theme.dim + theme.italic };
  }
  if (detail?.kind === "note") return { text: `  ${detail.text}`, color: theme.dim + theme.italic };
  return null;
}

/** What each syntax part is for, as D's popup describes it. */
const PART_HELP: Record<string, string> = {
  "/name": "the macro's name, e.g. /brief",
  "[description]": "optional, shown in autocomplete",
  "= text": "what it expands to",
  "= new text": "the new text",
  "add | edit | rm | list | undo": "what to do",
};

export interface PopupRow {
  name: string;
  desc: string;
  descColor?: string;
}

/** D's single popup row when there is nothing to complete: the error, the preview, or the part to type. */
export function popupMacroRow(guide: MacroGuide): PopupRow | null {
  const detail = guide.detail;
  if (detail?.kind === "error") return { name: "✗", desc: detail.text, descColor: theme.error };
  if (detail?.kind === "preview") return { name: detail.label, desc: `→ ${detail.text}` };
  if (detail?.kind === "note") return { name: "", desc: detail.text };
  const active = guide.syntax.find(part => part.active);
  return active ? { name: active.text, desc: PART_HELP[active.text] ?? "" } : null;
}
