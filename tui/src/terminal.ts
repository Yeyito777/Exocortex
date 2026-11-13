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
// Kitty OSC 5522 companion mode: terminal paste actions report available MIME
// types so applications can request images and other non-text clipboard data.
export const query_clipboard_paste_events = `${ESC}?5522$p`;
export const enable_clipboard_paste_events = `${ESC}?5522h`;
export const disable_clipboard_paste_events = `${ESC}?5522l`;
export const enable_kitty_kbd = `${ESC}>27u`;  // push kitty kbd: disambiguate + event types + all keys + associated text
export const disable_kitty_kbd = `${ESC}<u`;    // pop keyboard mode
// All motion + SGR extended encoding + st's modifier change reports (Shift without moving the mouse).
export const enable_mouse = `${ESC}?1003h${ESC}?1006h${ESC}?7778h`;
export const disable_mouse = `${ESC}?1003l${ESC}?1006l${ESC}?7778l`;

/** OSC 777 mouseshape: switch X cursor between text (I-beam), pointer (arrow), and hand (clickable). */
export const mouse_cursor_text = `\x1b]777;mouseshape;text\x07`;
export const mouse_cursor_pointer = `\x1b]777;mouseshape;pointer\x07`;
export const mouse_cursor_hand = `\x1b]777;mouseshape;hand\x07`;
export const cursor_block = `${ESC}2 q`;       // steady block (vim normal)
export const cursor_underline = `${ESC}4 q`;   // steady underline (vim pending operator)
export const cursor_bar = `${ESC}6 q`;         // steady bar (vim insert / default)
export const erase_to_eol = `${ESC}K`;         // erase to end of line (uses current bg)
export const RESET = `${ESC}0m`;

// ── Theme colours in the terminal ─────────────────────────────────

/** The colours a theme asks of the terminal itself, as hex (`#rrggbb`). */
export interface TerminalThemeColors {
  cursorColor?: string;
  /** Default foreground and background: uncoloured text, and the window padding. */
  terminalFg?: string;
  terminalBg?: string;
}

/** OSC numbers: 10 default foreground, 11 default background, 12 cursor. */
type ColorCode = 10 | 11 | 12;

const THEME_COLOR_CODES: ReadonlyArray<[ColorCode, keyof TerminalThemeColors]> = [
  [12, "cursorColor"], [10, "terminalFg"], [11, "terminalBg"],
];

/**
 * Ask the terminal for its own default colours and cursor colour. Sent once,
 * before any theme changes them, so they can be put back by value: st on
 * macOS ignores the reset sequences (OSC 110-112).
 */
export const query_terminal_colors = `\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\`;

/** What the terminal answered, by OSC number. */
const ownColors = new Map<ColorCode, string>();

const COLOR_REPLY = /^\x1b\](1[012]);rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x07|\x1b\\)$/i;

/**
 * Take a terminal's answer to `query_terminal_colors`. True when `sequence`
 * was one. Only the first answer for each colour counts (later ones would be
 * a theme's), and not one equal to what `active` has set: that is a theme
 * left behind by a TUI that was killed.
 */
export function handle_terminal_color_reply(sequence: string, active: TerminalThemeColors = {}): boolean {
  const match = COLOR_REPLY.exec(sequence);
  if (!match) return false;
  const code = Number(match[1]) as ColorCode;
  const hex = `#${match.slice(2, 5).map(channel => channel.slice(0, 2).toLowerCase()).join("")}`;
  const key = THEME_COLOR_CODES.find(([candidate]) => candidate === code)![1];
  if (!ownColors.has(code) && active[key]?.toLowerCase() !== hex) ownColors.set(code, hex);
  return true;
}

/** Forget the terminal's answers (tests). */
export function forget_terminal_colors(): void {
  ownColors.clear();
}

const setColor = (code: ColorCode, hex: string) => `\x1b]${code};${hex}\x1b\\`;

/** Put one colour back: by value where the terminal told us it, then the reset it may honour. */
function restoreColor(code: ColorCode): string {
  const own = ownColors.get(code);
  return (own ? setColor(code, own) : "") + `\x1b]1${code}\x1b\\`;
}

/**
 * Give the terminal a theme's cursor colour and default colours (OSC 12, 10,
 * 11). `restoreOthers` also puts back the ones this theme leaves alone, for a
 * switch away from a theme that set them.
 */
export function apply_theme_colors(colors: TerminalThemeColors, restoreOthers = false): string {
  return THEME_COLOR_CODES.map(([code, key]) => {
    const hex = colors[key];
    return hex ? setColor(code, hex) : restoreOthers ? restoreColor(code) : "";
  }).join("");
}

/** Give back what `apply_theme_colors` set. */
export function reset_theme_colors(colors: TerminalThemeColors): string {
  return THEME_COLOR_CODES.map(([code, key]) => colors[key] ? restoreColor(code) : "").join("");
}

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
