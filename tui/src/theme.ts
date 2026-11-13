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
import { adaptAnsiTruecolor, darkenToContrast, detectTerminalColorLevel, hexToAnsiColor, hexToRgb, rgbToAnsi } from "./terminalcolors";

// ── Theme interface ─────────────────────────────────────────────────

export interface Theme {
  name: string;
  /** Accent, secondary accent, and app background used by the theme preview. */
  previewColors: readonly [string, string, string];
  /**
   * Dark text on a light background. Faint text then fades toward the
   * background instead of darkening (lightfaint.ts), and colours that come
   * from outside the theme are darkened until they read (`inkAnsi`).
   */
  light?: boolean;

  // Reset
  reset: string;

  // Style modifiers
  bold: string;
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
  topbarFg?: string;      // Text on the top bar (unset = the terminal's default foreground)
  userBg: string;         // User message bubble
  automatedUserBg: string; // Automated user-role message bubble
  sidebarBg: string;      // Sidebar body
  sidebarSelBg: string;   // Sidebar selected item
  cursorBg: string;       // Inline cursor (history, visual mode)
  cursorFg: string;       // Text under the inline cursor
  historyLineBg: string;  // Selected line background in history
  selectionBg: string;    // Visual mode selection highlight
  searchBg: string;       // Search-match highlight background
  searchFg: string;       // Search-match highlight foreground
  notificationBg: string; // Unread-count badge background
  notificationFg: string; // Unread-count badge foreground
  appBg?: string;         // App-wide background (empty = terminal default)
  panelBg: string;        // Tasks and Scratchpad cards
  cursorColor?: string;   // Terminal cursor color as hex (e.g. "#48cae4")
  /**
   * The terminal's own default foreground and background as hex while this
   * theme is active (OSC 10/11): text the TUI leaves uncoloured, and the
   * window padding around the cells. Unset = the terminal keeps its own.
   */
  terminalFg?: string;
  terminalBg?: string;

  // Code: inline spans and fenced blocks
  codeBg: string;         // Inline code background
  codeText: string;       // Code with no token colour
  codeGutter: string;     // Fenced block gutter
  codeLabel: string;      // Fenced block language label
  synKeyword: string;
  synString: string;
  synComment: string;
  synNumber: string;
  synType: string;
  synFunction: string;
  synOperator: string;
  synPunct: string;

  // Border colors
  borderFocused: string;  // Focused panel border
  borderUnfocused: string; // Unfocused panel border

  // Style end
  boldOff: string;        // End bold
  italicOff: string;      // End italic
}

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

/** Keys that are not ANSI escapes: the name and plain hex colours. */
const HEX_KEYS = new Set<keyof Theme>(["name", "previewColors", "cursorColor", "terminalFg", "terminalBg"]);
/** Keys a theme may leave out: switching themes must clear them rather than keep the last theme's. */
const OPTIONAL_KEYS = ["light", "topbarFg", "appBg", "cursorColor", "terminalFg", "terminalBg"] as const satisfies ReadonlyArray<keyof Theme>;

function adaptThemeForTerminal(base: Theme): Theme {
  const adapted: Theme = { ...base };
  for (const key of OPTIONAL_KEYS) {
    if (!(key in adapted)) (adapted as unknown as Record<string, undefined>)[key] = undefined;
  }
  for (const key of Object.keys(adapted) as Array<keyof Theme>) {
    const value = adapted[key];
    if (HEX_KEYS.has(key) || typeof value !== "string") continue;
    (adapted as unknown as Record<string, string>)[key] = adaptAnsiTruecolor(value, terminalColorLevel);
  }
  return adapted;
}

// Start with whale, adapted to the current terminal's color depth, then
// immediately overwrite from persisted config.
// We use Object.assign so the exported `theme` reference stays the same
// object — every module that imported it sees mutations in-place.
export const theme: Theme = adaptThemeForTerminal(whale);

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

/** Contrast against the page that a colour from outside the theme must reach on a light theme. */
export const INK_CONTRAST = 4.5;

/**
 * Foreground escape for a colour the theme did not choose (a tool's own
 * colour, a registry default). Those are picked for dark backgrounds; on a
 * light theme one too pale to read is darkened, keeping its hue.
 */
export function inkAnsi(hex: string): string {
  if (!theme.light) return hexToAnsi(hex);
  const page = hexToRgb(theme.terminalBg ?? "#ffffff");
  const [r, g, b] = darkenToContrast(hexToRgb(hex), page, INK_CONTRAST);
  return rgbToAnsi(38, r, g, b, terminalColorLevel);
}

/** Convert a hex color (#rrggbb) to an ANSI background escape for this terminal. */
export function hexToAnsiBg(hex: string): string {
  return hexToAnsiColor(48, hex, terminalColorLevel);
}
