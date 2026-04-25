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

// ── Theme interface ─────────────────────────────────────────────────

export interface Theme {
  name: string;

  // Reset
  reset: string;

  // Style modifiers
  bold: string;
  dim: string;
  italic: string;

  // Foreground colors
  accent: string;      // Primary accent
  text: string;        // Default text
  muted: string;       // Muted gray (explicit fg color, not dim attribute)
  error: string;       // Errors, interruptions
  warning: string;     // Streaming indicator
  success: string;     // Connected indicator
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
  sidebarBg: string;      // Sidebar body
  sidebarSelBg: string;   // Sidebar selected item
  cursorBg: string;       // Inline cursor (history, visual mode)
  historyLineBg: string;  // Selected line background in history
  selectionBg: string;    // Visual mode selection highlight
  searchBg: string;       // Search-match highlight background
  searchFg: string;       // Search-match highlight foreground
  appBg?: string;         // App-wide background (empty = terminal default)
  cursorColor?: string;   // Terminal cursor color as hex (e.g. "#48cae4")

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
};

export const THEME_NAMES = Object.keys(themes) as ThemeName[];
export type ThemeName = keyof typeof themes;

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

// Start with whale, then immediately overwrite from persisted config.
// We use Object.assign so the exported `theme` reference stays the same
// object — every module that imported it sees mutations in-place.
export const theme: Theme = { ...whale };

const persisted = loadPersistedThemeName();
if (persisted) {
  Object.assign(theme, themes[persisted]);
}

/**
 * Switch the active theme at runtime.
 * Mutates the shared `theme` object in-place and persists the choice.
 * Returns true if the theme was found and applied, false otherwise.
 */
export function setTheme(name: string): boolean {
  const t = themes[name];
  if (!t) return false;
  Object.assign(theme, t);
  persistThemeName(name);
  return true;
}

// ── Utilities ──────────────────────────────────────────────────────

/** Convert a hex color (#rrggbb) to an ANSI truecolor foreground escape. */
export function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
