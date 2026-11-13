/**
 * Theme system for the Exocortex TUI.
 *
 * Defines the Theme interface and exports the active theme.
 * Every file that needs colors imports from here — no hardcoded
 * ANSI codes anywhere else in the TUI.
 *
 * The active `theme` object is mutated in-place so that every module
 * that imported it sees changes immediately — no re-imports needed.
 */

import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";
import { whale } from "./themes/whale";
import { cerberus } from "./themes/cerberus";
import { tonikawa } from "./themes/tonikawa";
import { paper } from "./themes/paper";
import { adaptAnsiTruecolor, detectTerminalColorLevel, hexToAnsiColor, hexToRgb } from "./terminalcolors";

// ── Theme interface ─────────────────────────────────────────────────

/** What every theme file sets. */
export interface BaseTheme {
  name: string;
  /** Accent, secondary accent, and app background used by the theme preview. */
  previewColors: readonly [string, string, string];

  // Reset
  reset: string;

  // Style modifiers
  bold: string;
  /**
   * De-emphasised text: SGR faint on the dark themes. st draws faint by halving
   * the colour, which on a light background is *more* ink, so a light theme
   * puts a faded foreground colour here. Callers therefore write `dim` after
   * the colour it fades, and end it with `reset` or a colour, never SGR 22.
   */
  dim: string;
  italic: string;

  // Foreground colors
  accent: string;      // Primary accent
  link: string;        // Clickable HTTP(S) links
  text: string;        // Default text
  muted: string;       // Muted gray (explicit fg color, not dim attribute)
  error: string;       // Errors, interruptions
  warning: string;     // Queued/suspended activity indicator
  success: string;     // Completed/unread activity indicator
  goal: string;        // Hidden goal-controller review indicator
  prompt: string;      // Input prompt ❯
  tool: string;        // Tool call labels
  command: string;     // Valid slash commands & macros in prompt

  // Vim mode indicators
  vimNormal: string;      // Normal mode label
  vimInsert: string;      // Insert mode label
  vimVisual: string;      // Visual mode label

  // Background colors
  topbarBg: string;       // Top bar
  userBg: string;         // User message bubble
  automatedUserBg: string; // Automated user-role message bubble
  sidebarBg: string;      // Sidebar body
  sidebarSelBg: string;   // Sidebar selected item
  cursorBg: string;       // Inline cursor (history, visual mode)
  historyLineBg: string;  // Selected line background in history
  selectionBg: string;    // Visual mode selection highlight
  searchBg: string;       // Search-match highlight background
  searchFg: string;       // Search-match highlight foreground
  notificationBg: string; // Unread-count badge background
  notificationFg: string; // Unread-count badge foreground
  appBg?: string;         // App-wide background (empty = terminal default)
  cursorColor?: string;   // Terminal cursor color as hex (e.g. "#48cae4")

  // Border colors
  borderFocused: string;  // Focused panel border
  borderUnfocused: string; // Unfocused panel border

  // Style end
  boldOff: string;        // End bold
  italicOff: string;      // End italic
}

/**
 * Colours that were once fixed in the code that draws them. The dark themes
 * share `DARK_SURFACES`; a theme that cannot (a light one) sets its own.
 */
export interface ThemeSurfaces {
  cursorFg: string;       // Text under the inline cursor (on cursorBg)
  heading: string;        // Scratchpad card headings
  panelBg: string;        // Tasks and Scratchpad cards
  inlineCodeBg: string;   // `inline code` tint
  topbarDim: string;      // Dim text on the top bar (cached-copy marker, queued model)

  // Code blocks
  codeText: string;       // Unhighlighted code
  codeGutter: string;     // Left rule
  codeLabel: string;      // Language name
  synKeyword: string;
  synString: string;      // Also added lines of a diff
  synComment: string;
  synNumber: string;      // Also removed lines of a diff
  synType: string;
  synFunction: string;
  synOperator: string;
  synPunct: string;

  /** Model ladder: the glow a step up arrives in, and the tint of a refused step. */
  ladderLight: string;
  ladderRefused: string;
}

export interface Theme extends BaseTheme, Partial<ThemeSurfaces> {
  /**
   * The terminal's own default foreground and background as hex, set with
   * OSC 10/11 while the theme is active (terminaltheme.ts). A light theme needs
   * both: text drawn without a colour and the window's padding use them.
   */
  terminalFg?: string;
  terminalBg?: string;
  /**
   * Lightest a tool's own colour may be, as contrast against `terminalBg`.
   * Tool colours come from the daemon and are picked for dark backgrounds;
   * a light theme darkens the ones that fall short (`toolColor`).
   */
  minToolContrast?: number;
}

/** The theme in use: every surface resolved. */
export type ActiveTheme = Theme & ThemeSurfaces;

const SGR = "\x1b[";
const fgHex = (hex: string) => hexToAnsiColor(38, hex, "truecolor");
const bgHex = (hex: string) => hexToAnsiColor(48, hex, "truecolor");

const DARK_SURFACES: ThemeSurfaces = {
  cursorFg:      fgHex("#000000"),
  heading:       fgHex("#b4bac4"),
  panelBg:       bgHex("#00050f"),
  inlineCodeBg:  bgHex("#162030"),
  topbarDim:     `${SGR}2m`,
  codeText:      fgHex("#ffffff"),
  codeGutter:    fgHex("#374150"),
  codeLabel:     fgHex("#505a69"),
  synKeyword:    fgHex("#c792ea"),  // soft purple
  synString:     fgHex("#c3e88d"),  // warm green
  synComment:    fgHex("#5f6978"),  // muted gray
  synNumber:     fgHex("#f78c6c"),  // warm orange
  synType:       fgHex("#89ddff"),  // soft cyan
  synFunction:   fgHex("#82aaff"),  // soft blue
  synOperator:   fgHex("#89ddff"),  // cyan
  synPunct:      fgHex("#b4b4b4"),  // light gray
  ladderLight:   fgHex("#ffd166"),
  ladderRefused: fgHex("#ff5c5c"),
};

// ── Available themes ────────────────────────────────────────────────

export const themes: Record<string, Theme> = {
  whale,
  cerberus,
  tonikawa,
  paper,
};

export const THEME_NAMES = Object.keys(themes) as ThemeName[];
export type ThemeName = keyof typeof themes;
export const terminalColorLevel = detectTerminalColorLevel();

// ── Config persistence ─────────────────────────────────────────────

/** Read the persisted theme name from config/config.json. */
function loadPersistedThemeName(): string | null {
  const data = readExocortexConfig();
  if (typeof data.theme === "string" && data.theme in themes) {
    return data.theme;
  }
  return null;
}

/** Write the theme name to config/config.json, preserving other config keys. */
function persistThemeName(name: string): void {
  updateExocortexConfig((config) => {
    config.theme = name;
  });
}

// ── Active theme ────────────────────────────────────────────────────

/** Slots holding a name or a hex colour rather than an escape sequence. */
const PLAIN_SLOTS = new Set<string>(["name", "cursorColor", "previewColors", "terminalFg", "terminalBg"]);
/** Optional slots: switching to a theme without one must clear the last theme's. */
const UNSET_OPTIONALS = { appBg: undefined, cursorColor: undefined, terminalFg: undefined, terminalBg: undefined, minToolContrast: undefined };

function adaptThemeForTerminal(base: Theme): ActiveTheme {
  const adapted = { ...UNSET_OPTIONALS, ...DARK_SURFACES, ...base };
  for (const key of Object.keys(adapted) as Array<keyof ActiveTheme>) {
    const value = adapted[key];
    if (PLAIN_SLOTS.has(key) || typeof value !== "string") continue;
    (adapted as unknown as Record<string, string>)[key] = adaptAnsiTruecolor(value, terminalColorLevel);
  }
  return adapted;
}

// Start with whale, adapted to the current terminal's color depth, then
// immediately overwrite from persisted config.
// We use Object.assign so the exported `theme` reference stays the same
// object — every module that imported it sees mutations in-place.
export const theme: ActiveTheme = adaptThemeForTerminal(whale);

const persisted = loadPersistedThemeName();
if (persisted) {
  Object.assign(theme, adaptThemeForTerminal(themes[persisted]));
}

/**
 * Switch the active theme at runtime.
 * Mutates the shared `theme` object in-place and persists the choice.
 * Returns true if the theme was found and applied, false otherwise.
 */
export function setTheme(name: string): boolean {
  const t = themes[name];
  if (!t) return false;
  Object.assign(theme, adaptThemeForTerminal(t));
  persistThemeName(name);
  return true;
}

// ── Utilities ──────────────────────────────────────────────────────

/** Convert a hex color (#rrggbb) to an ANSI foreground escape for this terminal. */
export function hexToAnsi(hex: string): string {
  return hexToAnsiColor(38, hex, terminalColorLevel);
}

/** Convert a hex color (#rrggbb) to an ANSI background escape for this terminal. */
export function hexToAnsiBg(hex: string): string {
  return hexToAnsiColor(48, hex, terminalColorLevel);
}

function luminance([r, g, b]: readonly number[]): number {
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tonedToolColors = new Map<string, string>();

/**
 * A tool's own colour as this theme can show it. The daemon's tool colours are
 * pastels for dark backgrounds; a theme with `minToolContrast` gets the same
 * hue darkened until it reads on `terminalBg`.
 */
export function toolColorHex(hex: string): string {
  const { terminalBg: background, minToolContrast: minimum } = theme;
  if (!background || !minimum || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const key = `${background}${minimum}${hex}`;
  let toned = tonedToolColors.get(key);
  if (toned === undefined) {
    toned = hex;
    const rgb = hexToRgb(hex);
    for (let scale = 0.96; contrastRatio(toned, background) < minimum && scale > 0; scale -= 0.04) {
      toned = `#${rgb.map(channel => Math.round(channel * scale).toString(16).padStart(2, "0")).join("")}`;
    }
    tonedToolColors.set(key, toned);
  }
  return toned;
}

/** Foreground escape of a tool's own colour (see `toolColorHex`). */
export function toolColor(hex: string): string {
  return hexToAnsi(toolColorHex(hex));
}
