/**
 * Faint text on a light background.
 *
 * SGR 2 (faint) is drawn by st as the colour at half brightness. On a dark
 * page that recedes; on a light one it comes out darker than the text around
 * it. So a light theme never sends SGR 2: this pass follows the colours and
 * weight of what is about to be written, as the terminal would, and gives
 * faint text its colour mixed toward the background it sits on.
 *
 * Every frame goes through here (frame.ts); on a dark theme it returns its
 * input untouched.
 */

import { theme, terminalColorLevel } from "./theme";
import { hexToRgb, rgbToAnsi, xterm256ToRgb, type TerminalColorLevel } from "./terminalcolors";

type Rgb = readonly [number, number, number];

/** How far faint text moves from its colour toward the background. */
export const FAINT_MIX = 0.36;

const SGR = /\x1b\[([0-9;]*)m/g;

interface PenState {
  /** Colours as the TUI set them (null = the terminal default). */
  fg: Rgb | null;
  bg: Rgb | null;
  bold: boolean;
  faint: boolean;
  /** The pass has changed the terminal's foreground away from `fg`. */
  mixed: boolean;
}

const pen: PenState = { fg: null, bg: null, bold: false, faint: false, mixed: false };

/** Forget the tracked state: the terminal was reset or the theme changed. */
export function resetFaintPen(): void {
  pen.fg = null;
  pen.bg = null;
  pen.bold = false;
  pen.faint = false;
  pen.mixed = false;
}

function mix(from: Rgb, to: Rgb): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * FAINT_MIX),
    Math.round(from[1] + (to[1] - from[1]) * FAINT_MIX),
    Math.round(from[2] + (to[2] - from[2]) * FAINT_MIX),
  ];
}

/** The colour an extended-colour parameter run (`38;2;r;g;b`, `38;5;n`) names, and how many parameters it took. */
function extendedColor(params: number[], at: number): { rgb: Rgb | null; length: number } {
  if (params[at + 1] === 2) return { rgb: [params[at + 2] ?? 0, params[at + 3] ?? 0, params[at + 4] ?? 0], length: 5 };
  if (params[at + 1] === 5) return { rgb: xterm256ToRgb(params[at + 2] ?? 0), length: 3 };
  return { rgb: null, length: 1 };
}

/**
 * Apply one SGR sequence to the pen. Returns what to write in its place, or
 * null to keep it as it is.
 */
function step(body: string, level: TerminalColorLevel): string | null {
  const params = body === "" ? [0] : body.split(";").map(Number);
  const kept: number[] = [];
  let fgChanged = false;
  let hadFaint = false;

  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) {
      pen.fg = null; pen.bg = null; pen.bold = false; pen.faint = false; pen.mixed = false;
      kept.push(0);
    } else if (code === 1) {
      pen.bold = true;
      kept.push(1);
    } else if (code === 2) {
      pen.faint = true;
      hadFaint = true;
    } else if (code === 22) {
      pen.bold = false; pen.faint = false;
      kept.push(22);
    } else if (code === 38) {
      const { rgb, length } = extendedColor(params, i);
      pen.fg = rgb;
      fgChanged = true;
      i += length - 1;
    } else if (code === 39) {
      pen.fg = null;
      fgChanged = true;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      pen.fg = xterm256ToRgb(code >= 90 ? code - 82 : code - 30);
      fgChanged = true;
    } else if (code === 48) {
      const { rgb, length } = extendedColor(params, i);
      pen.bg = rgb;
      for (let k = 0; k < length; k++) kept.push(params[i + k]);
      i += length - 1;
    } else if (code === 58) {
      // Underline colour: its parameters are not attributes.
      const { length } = extendedColor(params, i);
      for (let k = 0; k < length; k++) kept.push(params[i + k]);
      i += length - 1;
    } else if (code === 49) {
      pen.bg = null;
      kept.push(49);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      pen.bg = xterm256ToRgb(code >= 100 ? code - 92 : code - 40);
      kept.push(code);
    } else {
      kept.push(code);
    }
  }

  const fade = pen.faint && !pen.bold;
  // Nothing faint before, during or after: the sequence stands as written.
  if (!fade && !pen.mixed && !hadFaint) return null;

  let out = kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
  if (fade) {
    const ink = pen.fg ?? hexToRgb(theme.terminalFg ?? "#000000");
    const page = pen.bg ?? hexToRgb(theme.terminalBg ?? "#ffffff");
    const [r, g, b] = mix(ink, page);
    out += rgbToAnsi(38, r, g, b, level);
    pen.mixed = true;
  } else if (pen.mixed || fgChanged) {
    // Back to the colour the TUI asked for.
    out += pen.fg ? rgbToAnsi(38, pen.fg[0], pen.fg[1], pen.fg[2], level) : "\x1b[39m";
    pen.mixed = false;
  }
  return out;
}

/** Rewrite terminal output so faint text reads as faint on a light theme. */
export function resolveFaint(payload: string, level: TerminalColorLevel = terminalColorLevel): string {
  if (!theme.light) return payload;
  let out: string[] | null = null;
  let last = 0;
  SGR.lastIndex = 0;
  for (let match = SGR.exec(payload); match; match = SGR.exec(payload)) {
    const replacement = step(match[1], level);
    if (replacement === null) continue;
    (out ??= []).push(payload.slice(last, match.index), replacement);
    last = match.index + match[0].length;
  }
  if (!out) return payload;
  out.push(payload.slice(last));
  return out.join("");
}
