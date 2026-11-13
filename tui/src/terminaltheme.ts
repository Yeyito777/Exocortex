/**
 * The terminal's own colours under a theme: cursor (OSC 12) and, for a theme
 * that names them, default foreground and background (OSC 10/11).
 *
 * A light theme has to move the terminal's defaults: text the TUI draws
 * without a colour, the character under the terminal's cursor and the
 * window's padding all use them. The colours the terminal started with are
 * asked for before the first change and put back by value on exit, since not
 * every terminal implements the reset sequences (st on macOS does not).
 */

import { theme } from "./theme";

const ST = "\x1b\\";
const FG = 10;
const BG = 11;
const CURSOR = 12;
type Osc = typeof FG | typeof BG | typeof CURSOR;

/** Ask for the terminal's default foreground, background and cursor colours. Send before the first `terminalThemeSequence`. */
export const TERMINAL_COLORS_QUERY = [FG, BG, CURSOR].map(osc => `\x1b]${osc};?${ST}`).join("");

/** What the terminal reported before we changed anything. */
const original = new Map<Osc, string>();
/** The colours that are ours right now. */
const changed = new Set<Osc>();

const REPLY = /^\x1b\](1[012]);rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)$/i;

/** Take a reply to `TERMINAL_COLORS_QUERY`. True when `sequence` was one. */
export function handleTerminalColorReply(sequence: string): boolean {
  const match = REPLY.exec(sequence);
  if (!match) return false;
  const osc = Number(match[1]) as Osc;
  // Channels come as 1-4 hex digits; the leading two are the byte. Only the
  // first reply counts: a later one would report a theme's colour.
  if (!original.has(osc)) {
    original.set(osc, `#${match.slice(2, 5).map(channel => channel.padEnd(2, channel).slice(0, 2)).join("")}`.toLowerCase());
  }
  return true;
}

function set(osc: Osc, hex: string): string {
  changed.add(osc);
  return `\x1b]${osc};${hex}${ST}`;
}

function restore(osc: Osc): string {
  if (!changed.delete(osc)) return "";
  const hex = original.get(osc);
  return hex ? `\x1b]${osc};${hex}${ST}` : `\x1b]${100 + osc}${ST}`;
}

/** Make the terminal's cursor and default colours those of the active theme. */
export function terminalThemeSequence(): string {
  const ownsDefaults = theme.terminalFg && theme.terminalBg;
  return (theme.cursorColor ? set(CURSOR, theme.cursorColor) : restore(CURSOR))
    + (ownsDefaults ? set(FG, theme.terminalFg!) + set(BG, theme.terminalBg!) : restore(FG) + restore(BG));
}

/** Give the terminal its own colours back (on exit). */
export function terminalThemeReset(): string {
  return restore(CURSOR) + restore(FG) + restore(BG);
}

/** Tests: forget what the terminal reported and what was changed. */
export function resetTerminalThemeForTests(): void {
  original.clear();
  changed.clear();
}
