/**
 * Terminal color capability detection and ANSI color downsampling.
 *
 * The TUI themes are authored as direct RGB colors, but not every terminal that
 * can run the TUI supports 24-bit SGR (`38;2;r;g;b` / `48;2;r;g;b`).  In
 * particular, macOS Terminal.app over SSH commonly advertises only
 * `TERM=xterm-256color` and leaves `COLORTERM` empty.  Emit xterm-256 colors in
 * that case instead of sending truecolor escapes that the terminal may render
 * incorrectly.
 */

const ESC = "\x1b[";

export type TerminalColorLevel = "truecolor" | "256" | "16";

export interface TerminalColorEnv {
  TERM?: string;
  COLORTERM?: string;
  TERM_PROGRAM?: string;
  EXOCORTEX_TUI_COLOR?: string;
  FORCE_COLOR?: string;
  NO_COLOR?: string;
}

const XTERM_256_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const ANSI_16_RGB: Array<[number, number, number]> = [
  [0, 0, 0],       // black
  [205, 0, 0],     // red
  [0, 205, 0],     // green
  [205, 205, 0],   // yellow
  [0, 0, 238],     // blue
  [205, 0, 205],   // magenta
  [0, 205, 205],   // cyan
  [229, 229, 229], // white
  [127, 127, 127], // bright black / gray
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function distanceSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

function nearestIndex(levels: readonly number[], value: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const dist = Math.abs(value - levels[i]);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/** Return the nearest xterm-256 palette index for an RGB color. */
export function rgbToXterm256(rIn: number, gIn: number, bIn: number): number {
  const r = clampByte(rIn);
  const g = clampByte(gIn);
  const b = clampByte(bIn);

  const ri = nearestIndex(XTERM_256_LEVELS, r);
  const gi = nearestIndex(XTERM_256_LEVELS, g);
  const bi = nearestIndex(XTERM_256_LEVELS, b);
  const cubeCode = 16 + (36 * ri) + (6 * gi) + bi;
  const cubeR = XTERM_256_LEVELS[ri];
  const cubeG = XTERM_256_LEVELS[gi];
  const cubeB = XTERM_256_LEVELS[bi];
  const cubeDist = distanceSq(r, g, b, cubeR, cubeG, cubeB);

  // xterm's grayscale ramp is often a better approximation for near-neutral
  // colors than the 6x6x6 cube.  Do not use it for visibly chromatic dark
  // colors, though: e.g. Whale's #090d35 user bubble is numerically closer to
  // xterm gray 234 than xterm blue 17, but choosing gray loses the semantic
  // blue tint and makes the UI look muddy in 256-color terminals.
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma > 12) return cubeCode;

  const avg = (r + g + b) / 3;
  const grayIndex = avg <= 8 ? 0 : avg >= 248 ? 23 : Math.round((avg - 8) / 10);
  const grayValue = 8 + (grayIndex * 10);
  const grayCode = 232 + grayIndex;
  const grayDist = distanceSq(r, g, b, grayValue, grayValue, grayValue);

  return grayDist < cubeDist ? grayCode : cubeCode;
}

/** Return the RGB approximation for an xterm-256 palette index. */
export function xterm256ToRgb(codeIn: number): [number, number, number] | null {
  const code = Math.round(codeIn);
  if (code < 0 || code > 255) return null;
  if (code < 16) return ANSI_16_RGB[code];
  if (code >= 232) {
    const value = 8 + ((code - 232) * 10);
    return [value, value, value];
  }

  const n = code - 16;
  const ri = Math.floor(n / 36);
  const gi = Math.floor((n % 36) / 6);
  const bi = n % 6;
  return [XTERM_256_LEVELS[ri], XTERM_256_LEVELS[gi], XTERM_256_LEVELS[bi]];
}

/** Return the nearest ANSI 16-color palette index for an RGB color. */
export function rgbToAnsi16(rIn: number, gIn: number, bIn: number): number {
  const r = clampByte(rIn);
  const g = clampByte(gIn);
  const b = clampByte(bIn);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI_16_RGB.length; i++) {
    const [pr, pg, pb] = ANSI_16_RGB[i];
    const dist = distanceSq(r, g, b, pr, pg, pb);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function sgr16(kind: 38 | 48, idx: number): string {
  if (kind === 38) return `${ESC}${idx < 8 ? 30 + idx : 90 + idx - 8}m`;
  return `${ESC}${idx < 8 ? 40 + idx : 100 + idx - 8}m`;
}

export function rgbToAnsi(kind: 38 | 48, r: number, g: number, b: number, level: TerminalColorLevel): string {
  if (level === "truecolor") return `${ESC}${kind};2;${clampByte(r)};${clampByte(g)};${clampByte(b)}m`;
  if (level === "256") return `${ESC}${kind};5;${rgbToXterm256(r, g, b)}m`;
  return sgr16(kind, rgbToAnsi16(r, g, b));
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  const expanded = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return [255, 255, 255];
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

export function hexToAnsiColor(kind: 38 | 48, hex: string, level: TerminalColorLevel): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToAnsi(kind, r, g, b, level);
}

const TRUECOLOR_SGR_RE = /\x1b\[(38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/g;
const SGR_RE = /\x1b\[([0-9;]*)m/g;

function ansi16SgrToIndex(kind: 38 | 48, code: number): number | null {
  const normalBase = kind === 38 ? 30 : 40;
  const brightBase = kind === 38 ? 90 : 100;
  if (code >= normalBase && code <= normalBase + 7) return code - normalBase;
  if (code >= brightBase && code <= brightBase + 7) return 8 + code - brightBase;
  return null;
}

/** Extract an RGB approximation from a foreground/background SGR escape. */
export function ansiColorToRgb(ansi: string, kind: 38 | 48): [number, number, number] | null {
  for (const match of ansi.matchAll(SGR_RE)) {
    const params = match[1].split(";").filter(Boolean).map(Number);
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === kind && params[i + 1] === 2) {
        return [clampByte(params[i + 2]), clampByte(params[i + 3]), clampByte(params[i + 4])];
      }
      if (code === kind && params[i + 1] === 5) {
        return xterm256ToRgb(params[i + 2]);
      }
      const ansi16 = ansi16SgrToIndex(kind, code);
      if (ansi16 !== null) return ANSI_16_RGB[ansi16];
    }
  }
  return null;
}

/** Convert truecolor SGR escapes in arbitrary ANSI text to the requested color depth. */
export function adaptAnsiTruecolor(text: string, level: TerminalColorLevel): string {
  if (level === "truecolor" || !text.includes(";2;")) return text;
  return text.replace(TRUECOLOR_SGR_RE, (_match, kind: string, r: string, g: string, b: string) => (
    rgbToAnsi(Number(kind) as 38 | 48, Number(r), Number(g), Number(b), level)
  ));
}

function normalizeOverride(value: string | undefined): TerminalColorLevel | null {
  switch (value?.trim().toLowerCase()) {
    case "3":
    case "truecolor":
    case "24bit":
    case "24-bit":
    case "rgb":
      return "truecolor";
    case "2":
    case "256":
    case "256color":
    case "8bit":
    case "8-bit":
      return "256";
    case "1":
    case "16":
    case "ansi":
    case "basic":
      return "16";
    default:
      return null;
  }
}

/**
 * Detect a conservative color level from common terminal environment values.
 *
 * This intentionally does not treat `xterm-256color` as truecolor.  Many modern
 * terminal emulators support truecolor while still using that TERM value, but
 * the portable signal for that is COLORTERM=truecolor/24bit or a `*-direct`
 * terminfo.  Without that, xterm-256color means exactly 256 colors.
 */
export function detectTerminalColorLevel(env: TerminalColorEnv = process.env as unknown as TerminalColorEnv): TerminalColorLevel {
  const explicit = normalizeOverride(env.EXOCORTEX_TUI_COLOR);
  if (explicit) return explicit;

  // Respect common color knobs when a caller explicitly sets them.  NO_COLOR is
  // interpreted as the lowest colored mode rather than disabling ANSI entirely;
  // the TUI layout currently depends on style resets and highlighted regions.
  if (env.NO_COLOR) return "16";
  const forced = normalizeOverride(env.FORCE_COLOR);
  if (forced) return forced;

  const term = (env.TERM ?? "").toLowerCase();
  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();

  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
  if (term.includes("direct") || term.includes("truecolor") || term.includes("24bit")) return "truecolor";

  // Common terminal identifiers that are truecolor-capable even when their
  // terminfo name does not use the newer `*-direct` convention.  Keep generic
  // `xterm-256color` out of this list because it is also what Apple Terminal.app
  // commonly reports.
  if (/^(xterm-kitty|wezterm|foot|foot-extra|alacritty|rio|ghostty|st|st-.*)$/.test(term)) return "truecolor";

  // These programs generally expose truecolor accurately when run locally.  Over
  // SSH this variable is often absent; TERM/COLORTERM remain the portable path.
  if (["wezterm", "ghostty", "kitty", "iterm.app"].includes(termProgram)) return "truecolor";

  // Apple Terminal.app commonly reports xterm-256color and has historically not
  // been a reliable truecolor target, so keep it on the 256-color path unless a
  // stronger signal above says otherwise.
  if (termProgram === "apple_terminal") return "256";

  if (term.includes("256color") || term.includes("256")) return "256";
  return "16";
}
