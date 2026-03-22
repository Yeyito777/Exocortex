/**
 * Terminal lifecycle utilities.
 *
 * ANSI escape sequences for entering/leaving the alternate screen,
 * cursor visibility, and screen clearing. Used by main.ts for
 * terminal setup/teardown.
 */

const ESC = "\x1b[";

export const hide_cursor = `${ESC}?25l`;
export const show_cursor = `${ESC}?25h`;
export const enter_alt = `${ESC}?1049h`;
export const leave_alt = `${ESC}?1049l`;
export const enable_bracketed_paste = `${ESC}?2004h`;
export const disable_bracketed_paste = `${ESC}?2004l`;
export const enable_kitty_kbd = `${ESC}>1u`;   // push disambiguate mode (kitty keyboard protocol)
export const disable_kitty_kbd = `${ESC}<u`;    // pop keyboard mode
export const cursor_block = `${ESC}2 q`;       // steady block (vim normal)
export const cursor_underline = `${ESC}4 q`;   // steady underline (vim pending operator)
export const cursor_bar = `${ESC}6 q`;         // steady bar (vim insert / default)
export const erase_to_eol = `${ESC}K`;         // erase to end of line (uses current bg)
export const RESET = `${ESC}0m`;

/** OSC 12: set terminal cursor color (hex string like "#rrggbb"). */
export const set_cursor_color = (hex: string) => `\x1b]12;${hex}\x1b\\`;
/** OSC 112: reset terminal cursor color to default. */
export const reset_cursor_color = `\x1b]112\x1b\\`;

// ── Rendering primitives ──────────────────────────────────────────

/**
 * Apply a background color as a layer beneath line content.
 *
 * - Sets bg then immediately erases to EOL, flooding the rest of
 *   the row with the desired background
 * - Content is drawn on top, overwriting the filled cells
 * - Replaces every \x1b[0m reset with reset + re-apply bg
 *   (so bg persists through styled spans)
 * - Resets at end so subsequent lines are clean
 *
 * erase_to_eol comes *before* the content so that full-width lines
 * (e.g. separator ─ rows) don't lose their last character to a
 * trailing \x1b[K issued at the rightmost column.
 *
 * Works for any line: text, empty, metadata, padding.
 */
export function applyLineBg(line: string, bg: string): string {
  // Replace all resets with reset + bg re-apply
  const patched = line.replaceAll(RESET, `${RESET}${bg}`);
  return `${bg}${erase_to_eol}${patched}${RESET}`;
}
