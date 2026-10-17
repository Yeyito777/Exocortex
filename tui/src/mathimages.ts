/**
 * Display math as typeset images (Kitty graphics terminals).
 *
 * Standalone `$$…$$` / `\[…\]` blocks in assistant history are typeset by a
 * worker (MathJax → SVG → PNG, see mathimages-worker.ts) at the terminal's
 * cell pixel size, in the theme's text colour on a transparent background,
 * and drawn as an indented Kitty placement through the history image pipeline
 * (historyimages.ts), so scrolling, resizing, overlays and covers crop them
 * exactly like pasted images.
 *
 * The image behaves as text: its cells hold the equation's TeX as concealed
 * (SGR 8) text, and the placement sits below text (negative z). The terminal
 * shows the image through the concealed cells, a native mouse selection
 * copies the TeX, and cell backgrounds (the history line highlight, cursor,
 * search matches, the terminal's selection) show through the transparent
 * pixels behind the glyphs instead of covering them.
 *
 * Rendering is asynchronous: until an equation's PNG is ready (and forever if
 * its TeX is malformed or the renderer is unavailable) the block keeps the
 * Unicode text rendering from markdown/math.ts. Inline math always stays
 * text: an image inside a wrapped line would have to fit one cell row, which
 * is too small for fractions or scripts, and would break word wrapping,
 * cursor motions, search and link spans that work on characters.
 *
 * `EXOCORTEX_TUI_MATH=auto|text|image` (or `tui.math` in config.json)
 * overrides detection: `text` never renders images, `image` renders them even
 * when the terminal did not answer the Kitty graphics query.
 */

import { readExocortexConfig } from "@exocortex/shared/config";
import type { KittyImageData } from "./kittyimages";
import { inlineImageCellSize, inlineImageMode, type CellSize } from "./inlineimages";
import { log } from "./log";
import { termWidth } from "./textwidth";
import { theme, themes } from "./theme";
import type { WrapCopyLine, WrapImage, WrapImageRow } from "./textwrap";

// ── Settings ────────────────────────────────────────────────────────

export type MathRenderSetting = "auto" | "text" | "image";

function parseSetting(value: unknown): MathRenderSetting | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "auto" || normalized === "text" || normalized === "image" ? normalized : null;
}

/** The env var wins over config.json; anything unrecognised means auto. */
export function resolveMathRenderSetting(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: () => { tui?: { math?: unknown } } = readExocortexConfig,
): MathRenderSetting {
  const fromEnv = parseSetting(env.EXOCORTEX_TUI_MATH);
  if (fromEnv) return fromEnv;
  try {
    return parseSetting(readConfig().tui?.math) ?? "auto";
  } catch {
    return "auto";
  }
}

let setting: MathRenderSetting | null = null;

function currentSetting(): MathRenderSetting {
  return setting ??= resolveMathRenderSetting();
}

/** Auto mode needs the terminal graphics query even when history images are off. */
export function mathImagesNeedDetection(): boolean {
  return currentSetting() === "auto";
}

/** Whether display math in history renders as images right now. */
export function mathImagesActive(): boolean {
  const current = currentSetting();
  if (current === "text") return false;
  if (current === "image") return true;
  return inlineImageMode() === "kitty";
}

// ── Render requests ─────────────────────────────────────────────────

/** Display math em size relative to the cell height (terminal fonts fill ~80% of a cell). */
export const DISPLAY_MATH_EM_PER_CELL = 0.9;

export interface MathRenderRequest {
  id: number;
  tex: string;
  display: boolean;
  emPx: number;
  cellWidth: number;
  cellHeight: number;
  color: string;
  /** Scale a wider equation down to this many cells (or fail when it would be unreadable). */
  maxCols?: number;
}

export type MathRenderResponse =
  | { id: number; ok: true; base64: string; pixelWidth: number; pixelHeight: number; cols: number; rows: number }
  | { id: number; ok: false; error: string };

export type MathRasterizer = (request: MathRenderRequest) => Promise<MathRenderResponse>;

let textHex: { themeName: string; hex: string } | null = null;

/** `#rrggbb` of the theme's default text colour. */
export function themeTextHex(): string {
  if (textHex?.themeName === theme.name) return textHex.hex;
  // The theme's own truecolor value, not the copy adapted to a 256-colour terminal.
  const match = /38;2;(\d+);(\d+);(\d+)m/.exec(themes[theme.name]?.text ?? theme.text);
  const hex = match
    ? `#${match.slice(1).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, "0")).join("")}`
    : "#ffffff";
  textHex = { themeName: theme.name, hex };
  return hex;
}

/** Everything an image depends on besides its TeX and width cap. */
export function mathRenderEnvironment(cell: CellSize = inlineImageCellSize(), color = themeTextHex()): Omit<MathRenderRequest, "id" | "tex" | "maxCols"> {
  return {
    display: true,
    emPx: Math.max(6, Math.round(cell.height * DISPLAY_MATH_EM_PER_CELL)),
    cellWidth: cell.width,
    cellHeight: cell.height,
    color,
  };
}

export function mathRequestKey(request: Omit<MathRenderRequest, "id">): string {
  const fit = request.maxCols === undefined ? "" : `:fit${request.maxCols}`;
  return `${request.display ? "D" : "I"}:${request.emPx}:${request.cellWidth}x${request.cellHeight}:${request.color}${fit}:${request.tex}`;
}

// ── Worker rasterizer ───────────────────────────────────────────────

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;
const waiting = new Map<number, (response: MathRenderResponse) => void>();

function failWaiting(error: string): void {
  for (const [id, resolve] of waiting) resolve({ id, ok: false, error });
  waiting.clear();
}

function workerRasterizer(request: MathRenderRequest): Promise<MathRenderResponse> {
  if (workerBroken) return Promise.resolve({ id: request.id, ok: false, error: "math renderer unavailable" });
  if (!worker) {
    try {
      worker = new Worker(new URL("./mathimages-worker.ts", import.meta.url).href, { type: "module" });
      // The worker must never keep the TUI alive at exit.
      (worker as Worker & { unref?: () => void }).unref?.();
      worker.onmessage = (event: MessageEvent<MathRenderResponse>) => {
        const resolve = waiting.get(event.data.id);
        waiting.delete(event.data.id);
        resolve?.(event.data);
      };
      worker.onerror = event => {
        log("warn", `tui: math renderer failed: ${event.message}`);
        workerBroken = true;
        worker?.terminate();
        worker = null;
        failWaiting("math renderer unavailable");
      };
    } catch (error) {
      log("warn", `tui: math renderer unavailable: ${error instanceof Error ? error.message : String(error)}`);
      workerBroken = true;
      return Promise.resolve({ id: request.id, ok: false, error: "math renderer unavailable" });
    }
  }
  return new Promise(resolve => {
    waiting.set(request.id, resolve);
    worker!.postMessage(request);
  });
}

// ── Cache ───────────────────────────────────────────────────────────

export interface MathImage {
  kitty: KittyImageData;
  cols: number;
  rows: number;
}

type Entry =
  | { phase: "pending" }
  | { phase: "error"; error: string }
  | { phase: "ready"; image: MathImage };

const MAX_ENTRIES = 512;
const MAX_CACHED_CHARS = 48 * 1024 * 1024;
/** Kitty ids of math images: below inline previews (0x40000000+) and the query id. */
const FIRST_KITTY_ID = 0x20000000;
const LAST_KITTY_ID = 0x3fffffff;

const entries = new Map<string, Entry>();
let cachedChars = 0;
let nextKittyId = FIRST_KITTY_ID;
let generation = 0;
let rasterize: MathRasterizer = workerRasterizer;
let onChange: () => void = () => {};

export function configureMathImages(options: { onChange: () => void }): void {
  onChange = options.onChange;
}

/** Changes whenever a pending equation settles; blocks that showed it as text re-render. */
export function mathImageGeneration(): number {
  return generation;
}

function entryChars(entry: Entry): number {
  return entry.phase === "ready" ? entry.image.kitty.base64.length : 0;
}

function store(key: string, entry: Entry): void {
  const previous = entries.get(key);
  if (previous) cachedChars -= entryChars(previous);
  entries.delete(key);
  entries.set(key, entry);
  cachedChars += entryChars(entry);
  for (const [oldKey, old] of entries) {
    if (entries.size <= MAX_ENTRIES && cachedChars <= MAX_CACHED_CHARS) break;
    if (old.phase === "pending" || oldKey === key) continue;
    entries.delete(oldKey);
    cachedChars -= entryChars(old);
  }
}

function settle(key: string, response: MathRenderResponse): void {
  if (response.ok) {
    const kittyId = nextKittyId;
    nextKittyId = nextKittyId >= LAST_KITTY_ID ? FIRST_KITTY_ID : nextKittyId + 1;
    store(key, {
      phase: "ready",
      image: {
        kitty: { kittyId, base64: response.base64, pixelWidth: response.pixelWidth, pixelHeight: response.pixelHeight },
        cols: response.cols,
        rows: response.rows,
      },
    });
  } else {
    store(key, { phase: "error", error: response.error });
  }
  generation++;
  onChange();
}

function lookup(request: Omit<MathRenderRequest, "id">): Entry {
  const key = mathRequestKey(request);
  const existing = entries.get(key);
  if (existing) {
    entries.delete(key);
    entries.set(key, existing);
    return existing;
  }
  const entry: Entry = { phase: "pending" };
  store(key, entry);
  const id = nextRequestId++;
  rasterize({ ...request, id }).then(
    response => settle(key, response),
    error => settle(key, { id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return entry;
}

export type MathImageState = { phase: "pending" } | { phase: "error"; error: string } | { phase: "ready"; image: MathImage };

/**
 * The image for one display equation at most `maxCols` wide. It is rendered
 * at its natural size first; only an equation wider than the pane needs a
 * second, scaled-down render for that width.
 */
export function displayMathImage(tex: string, maxCols: number, environment = mathRenderEnvironment()): MathImageState {
  const natural = lookup({ ...environment, tex });
  if (natural.phase !== "ready" || natural.image.cols <= maxCols) return natural;
  return lookup({ ...environment, tex, maxCols });
}

// ── Markdown hook ───────────────────────────────────────────────────

export interface DisplayMathImageRows {
  lines: string[];
  cont: boolean[];
  join: string[];
  copy: Array<WrapCopyLine | null>;
  images: Array<WrapImageRow | undefined>;
}

export interface DisplayMathImageRenderer {
  /** Image rows for one display block, or null to keep its text rendering. */
  render(tex: string, width: number, source: string): DisplayMathImageRows | null;
  /** True once any block rendered as text only because its image is still pending. */
  pending: boolean;
}

const CONCEAL = "\x1b[8m";
const REVEAL = "\x1b[28m";
const DELIMITER_LINE = /^(?:\$\$|\\\[|\\\])$/;
/** An unescaped `%` comments out the rest of a TeX line. */
const TEX_COMMENT = /(?:^|[^\\])(?:\\\\)*%/;

export interface HiddenTexRow {
  text: string;
  /** What joins this row to the previous one in the source: "\n", a wrapped-at space, or "" (first row, hard break). */
  join: string;
}

/** Breaking between `chars[at - 1]` and `chars[at]` keeps every control sequence whole. */
function texBreakSafe(chars: readonly string[], at: number): boolean {
  if (chars[at - 1] === "\\") return false;
  if (!/[A-Za-z]/.test(chars[at] ?? "")) return true;
  let start = at;
  while (start > 0 && /[A-Za-z]/.test(chars[start - 1])) start--;
  return !(start < at && chars[start - 1] === "\\");
}

function wrapTexLine(line: string, width: number, firstJoin: string, out: HiddenTexRow[]): void {
  let chars = Array.from(line);
  let join = firstJoin;
  for (;;) {
    let used = 0;
    let fit = 0;
    while (fit < chars.length && used + termWidth(chars[fit]) <= width) used += termWidth(chars[fit++]);
    if (fit >= chars.length) break;
    // Prefer a space (it becomes the row break); then any point outside a control word.
    let space = fit;
    while (space > 0 && chars[space] !== " ") space--;
    if (space > 0) {
      out.push({ text: chars.slice(0, space).join(""), join });
      chars = chars.slice(space + 1);
      join = " ";
      continue;
    }
    let at = Math.max(1, fit);
    while (at > 1 && !texBreakSafe(chars, at)) at--;
    if (!texBreakSafe(chars, at)) at = Math.max(1, fit);
    out.push({ text: chars.slice(0, at).join(""), join });
    chars = chars.slice(at);
    join = "";
  }
  out.push({ text: chars.join(""), join });
}

/**
 * Rows of hidden TeX for a display fragment's source at most `width` cells
 * wide. Continuation lines lose the indent they share (a list item's), and
 * lines holding only a delimiter join their neighbour (`$$x$$`, not three
 * rows); longer lines wrap at spaces, else between tokens. Joining the rows
 * with their `join`s gives back that compacted source.
 */
export function hiddenTexRows(source: string, width: number): HiddenTexRow[] {
  const lines = source.split("\n").map(line => line.trimEnd());
  const indent = Math.min(...lines.slice(1).filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length));
  if (Number.isFinite(indent)) for (let i = 1; i < lines.length; i++) lines[i] = lines[i].slice(indent);
  while (lines.length > 1 && !lines[0].trim()) lines.shift();
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length > 1 && DELIMITER_LINE.test(lines[0].trim())) lines.splice(0, 2, lines[0].trim() + lines[1].trimStart());
  const last = lines.length - 1;
  if (last > 0 && DELIMITER_LINE.test(lines[last].trim()) && !TEX_COMMENT.test(lines[last - 1])) {
    lines.splice(last - 1, 2, lines[last - 1] + lines[last].trim());
  }
  const rows: HiddenTexRow[] = [];
  lines.forEach((line, index) => wrapTexLine(line, Math.max(1, width), index === 0 ? "" : "\n", rows));
  return rows;
}

/** Display blocks sit this far in from the text margin, like the Unicode rendering. */
export const DISPLAY_MATH_INDENT = 2;

/**
 * Rows for a ready equation: the image indented like a text display block,
 * its TeX concealed in the cells under it from its left edge (vertically
 * centred, so a line selection on its middle row takes it all). Left-aligned
 * rather than centred because a terminal selection copies the blanks before
 * the TeX: this keeps them to the indent any text line has. The block grows
 * when the TeX needs more rows than the image. All rows form one logical
 * line: the history highlight covers the whole equation and a line yank
 * copies the source.
 */
export function displayMathImageRows(image: MathImage, width: number, source: string, index: number): DisplayMathImageRows {
  const col = Math.max(0, Math.min(width >= 24 ? DISPLAY_MATH_INDENT : 0, width - image.cols));
  const wrapImage: WrapImage = { kitty: image.kitty, col, cols: image.cols, rows: image.rows, index };
  const hidden = hiddenTexRows(source, width - col);
  const height = Math.max(image.rows, hidden.length);
  const imageTop = Math.floor((height - image.rows) / 2);
  const textTop = Math.floor((height - hidden.length) / 2);
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const copy: Array<WrapCopyLine | null> = [];
  const images: Array<WrapImageRow | undefined> = [];
  for (let row = 0; row < height; row++) {
    const tex = hidden[row - textTop];
    // Every row keeps the image's indent so narrow-history shifting moves them together.
    lines.push(" ".repeat(col) + (tex?.text ? CONCEAL + tex.text + REVEAL : ""));
    cont.push(row > 0);
    join.push(tex && row > textTop ? tex.join : "");
    // Charwise copies take the hidden text; whole-row copies the fragment's source, once.
    copy.push(tex
      ? { text: tex.text, displayStart: col, source: row === textTop ? source : null }
      : { text: "", displayStart: 0, skip: true });
    const imageRow = row - imageTop;
    images.push(imageRow >= 0 && imageRow < image.rows ? { image: wrapImage, row: imageRow } : undefined);
  }
  return { lines, cont, join, copy, images };
}

/** A renderer for one markdown render pass, or undefined when math stays text. */
export function createDisplayMathImageRenderer(): DisplayMathImageRenderer | undefined {
  if (!mathImagesActive()) return undefined;
  const environment = mathRenderEnvironment();
  let index = 0;
  const renderer: DisplayMathImageRenderer = {
    pending: false,
    render(body, width, source) {
      const tex = body.trim();
      if (!tex) return null;
      const state = displayMathImage(tex, Math.max(1, width), environment);
      if (state.phase === "pending") renderer.pending = true;
      if (state.phase !== "ready") return null;
      return displayMathImageRows(state.image, width, source, index++);
    },
  };
  return renderer;
}

/** Block-cache key: everything besides TeX and width that changes the rendering. */
export function mathImageCacheKey(): string {
  if (!mathImagesActive()) return "text";
  const environment = mathRenderEnvironment();
  return `${environment.emPx}:${environment.cellWidth}x${environment.cellHeight}:${environment.color}`;
}

export function disposeMathImages(): void {
  worker?.terminate();
  worker = null;
  failWaiting("math renderer stopped");
}

export const mathImagesInternalsForTest = {
  reset(options: { setting?: MathRenderSetting; rasterize?: MathRasterizer } = {}): void {
    entries.clear();
    cachedChars = 0;
    nextKittyId = FIRST_KITTY_ID;
    generation = 0;
    setting = options.setting ?? null;
    rasterize = options.rasterize ?? workerRasterizer;
    onChange = () => {};
    workerBroken = false;
  },
  workerRasterizer,
  entryCount: () => entries.size,
};
