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
 * The image behaves as text. Its PNG carries the equation's source in a
 * `selection-text` chunk (st makes such an image an atomic text object: a
 * native selection touching it highlights its whole cell rectangle and copies
 * that text once), and the placement sits below text (negative z), so cell
 * backgrounds (the history line highlight, cursor, selections) show through
 * the transparent pixels behind the glyphs instead of covering them. Its
 * cells stay blank; the TUI's own copies and visual selection treat the
 * block as one unit the same way.
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
  /** Embedded in the PNG as its `selection-text`: what selecting the image copies. */
  text?: string;
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
export function mathRenderEnvironment(cell: CellSize = inlineImageCellSize(), color = themeTextHex()): Omit<MathRenderRequest, "id" | "tex" | "maxCols" | "text"> {
  return {
    display: true,
    emPx: Math.max(6, Math.round(cell.height * DISPLAY_MATH_EM_PER_CELL)),
    cellWidth: cell.width,
    cellHeight: cell.height,
    color,
  };
}

export function mathRequestKey(request: Omit<MathRenderRequest, "id">): string {
  const fit = (request.maxCols === undefined ? "" : `:fit${request.maxCols}`)
    + (request.text === undefined ? "" : `:text${request.text.length}:${request.text}`);
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
export function displayMathImage(tex: string, maxCols: number, environment = mathRenderEnvironment(), text?: string): MathImageState {
  const natural = lookup({ ...environment, tex, ...(text === undefined ? {} : { text }) });
  if (natural.phase !== "ready" || natural.image.cols <= maxCols) return natural;
  return lookup({ ...environment, tex, maxCols, ...(text === undefined ? {} : { text }) });
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

/** Display blocks sit this far in from the text margin, like the Unicode rendering. */
export const DISPLAY_MATH_INDENT = 2;

/**
 * Rows for a ready equation: blank cells under the image, indented like a
 * text display block. All rows form one logical line and one copy unit: the
 * history highlight covers the whole equation, and any yank or visual
 * selection touching it copies the fragment's source once.
 */
export function displayMathImageRows(image: MathImage, width: number, source: string, index: number): DisplayMathImageRows {
  const col = Math.max(0, Math.min(width >= 24 ? DISPLAY_MATH_INDENT : 0, width - image.cols));
  const wrapImage: WrapImage = { kitty: image.kitty, col, cols: image.cols, rows: image.rows, index };
  const unit = {};
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const copy: Array<WrapCopyLine | null> = [];
  const images: WrapImageRow[] = [];
  for (let row = 0; row < image.rows; row++) {
    // Every row keeps the image's indent so narrow-history shifting moves them together.
    lines.push(" ".repeat(col));
    cont.push(row > 0);
    join.push("");
    copy.push({ text: source, displayStart: col, atomic: unit, source: row === 0 ? source : null });
    images.push({ image: wrapImage, row });
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
      const state = displayMathImage(tex, Math.max(1, width), environment, source);
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
