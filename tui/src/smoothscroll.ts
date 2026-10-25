/**
 * App-driven smooth scrolling of the conversation pane.
 *
 * On a terminal that supports it (st's mode 2032, ~/Config/st
 * docs/app-smooth-scroll.md) the TUI animates scrolls itself: the history is
 * laid out one whole row at a time, as usual, and the terminal draws the
 * moving rectangles shifted by the remaining fraction of a row. Each row the
 * animation crosses is an ordinary region scroll plus the rows it exposes or
 * re-wraps (beside the Tasks panel), so text re-wraps as it glides. Between
 * rows only a tiny offset update is sent. See docs/scroll-regions.md.
 */

const ESC = "\x1b";
const ST = `${ESC}\\`;

export const SMOOTH_SCROLL_QUERY = `${ESC}[?2032$p`;
export const SMOOTH_SCROLL_ON = `${ESC}[?2032h`;
export const SMOOTH_SCROLL_OFF = `${ESC}[?2032l`;
/** Same feel as st's own glides (smoothscroll_ms). */
export const SMOOTH_SCROLL_DURATION_MS = 100;
/** How often a moving glide checks whether it is about to cross a row. */
export const SMOOTH_SCROLL_FRAME_MS = 4;

/** DECRQM reply for mode 2032: true when the terminal can do it, null if not a reply. */
export function parseSmoothScrollReport(sequence: string): boolean | null {
  const match = /^\x1b\[\?2032;([0-4])\$y$/.exec(sequence);
  if (!match) return null;
  return match[1] === "1" || match[1] === "2";
}

/** A moving rectangle: 1-based, inclusive screen cells. */
export interface ScrollRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function rectsPayload(rects: readonly ScrollRect[]): string {
  const list = rects.map(rect => `;${rect.top},${rect.left},${rect.bottom},${rect.right}`).join("");
  return `${ESC}]2032;r${list}${ST}`;
}

export function offsetPayload(thousandths: number): string {
  return `${ESC}]2032;o;${thousandths}${ST}`;
}

/** Cubic ease-out remainder, 1 at the start and exactly 0 at the end (st's curve). */
export function easeRemaining(progress: number): number {
  if (!(progress < 1)) return 0;
  const rest = 1 - Math.max(0, progress);
  return rest * rest * rest;
}

/** OSC 2032 move: offset += dA rows; plus `ease` rows easing to 0 over `ms` (st times it). */
export function movePayload(deltaRows: number, easeRows = 0, ms = SMOOTH_SCROLL_DURATION_MS): string {
  const delta = Math.round(deltaRows * 1000);
  const ease = Math.round(easeRows * 1000);
  return ease === 0
    ? `${ESC}]2032;m;${delta}${ST}`
    : `${ESC}]2032;m;${delta};${ease};${ms}${ST}`;
}

/**
 * How far ahead of st's clock the TUI lays out rows: covers the frame poll,
 * a render and the trip through the pty, so the glide st draws never runs
 * past the lines its scrolls kept.
 */
export const SMOOTH_SCROLL_LEAD_MS = 30;

interface EaseTerm {
  rows: number;
  start: number;
}

/**
 * Scroll animation in scrollOffset units (rows from the bottom; larger is
 * older history, so content moves down on screen as it grows).
 *
 * The terminal draws the moving rectangles `offset` rows lower than laid out
 * (st's mode 2032), where offset = base + easing terms that st times itself
 * at the display's refresh. This class keeps the same curve so it knows
 * where st is: the eased position is `grid + offset`. Inputs move the
 * target (one move message: base += step, plus an easing term of -step, so
 * nothing jumps). The history is laid out at the whole row a little ahead of
 * the position in the direction of travel, so the strip a shifted rectangle
 * uncovers always shows lines st's own region scrolls kept; each row laid
 * out is a region scroll plus `base -= rows` in the same synchronized update.
 * Content that moved by itself (output streamed while following) gets an
 * easing term from where it was drawn.
 */
export class SmoothScroller {
  private target = 0;
  /** Whole offset of the last laid-out frame. */
  private grid = 0;
  private gridValid = false;
  private base = 0;
  private terms: EaseTerm[] = [];
  /** Region shift (up positive) the last layout step makes. */
  private expectedShift = 0;
  private height = 0;
  private sentRects = "";
  private context: string | null = null;
  /** Not yet sent: start over from `base` (`o`), then move by these. */
  private pendingReset = false;
  private pendingDelta = 0;
  private pendingEase = 0;
  private terminalNonzero = false;

  constructor(
    private readonly durationMs = SMOOTH_SCROLL_DURATION_MS,
    private readonly now: () => number = () => performance.now(),
    private readonly leadMs = SMOOTH_SCROLL_LEAD_MS,
  ) {}

  private offsetAt(time: number): number {
    let offset = this.base;
    for (const term of this.terms) offset += term.rows * easeRemaining((time - term.start) / this.durationMs);
    return offset;
  }

  private prune(time: number): void {
    this.terms = this.terms.filter(term => easeRemaining((time - term.start) / this.durationMs) > 0);
  }

  private addTerm(rows: number, time: number): void {
    if (rows === 0) return;
    const term = { rows, start: time };
    this.terms.push(term);
    this.unsent.push(term);
    this.pendingEase += rows;
  }

  /** Terms not sent yet: they start when st receives them. */
  private unsent: EaseTerm[] = [];

  /** Lay out at grid + offset from here on: base = target - grid, eased from `from`. */
  private restart(from: number, time: number): void {
    this.terms = [];
    this.unsent = [];
    this.base = this.target - this.grid;
    this.pendingReset = true;
    this.pendingDelta = 0;
    this.pendingEase = 0;
    this.addTerm(from - this.target, time);
  }

  private gridFor(time: number, maxOffset: number): number {
    const position = this.grid + this.offsetAt(time);
    if (position === this.target && this.terms.length === 0) return this.target;
    // Lay out where the glide will be a little later, but never more than
    // the row just past it: st draws the laid-out rows `offset` away from
    // where they were laid out, and only rigid content survives that. Beside
    // the Tasks panel rows re-wrap, so a fast glide laid out several rows
    // ahead showed narrow rows (with nothing on their right) below the panel.
    const ahead = this.grid + this.offsetAt(time + this.leadMs);
    let grid: number;
    if (this.target > position) {
      grid = Math.max(Math.ceil(position), Math.min(Math.ceil(ahead), Math.floor(position) + 1));
      grid = Math.min(this.target, grid);
    } else if (this.target < position) {
      grid = Math.min(Math.floor(position), Math.max(Math.floor(ahead), Math.ceil(position) - 1));
      grid = Math.max(this.target, grid);
    } else {
      grid = Math.round(position);
    }
    return Math.max(0, Math.min(maxOffset, grid));
  }

  /** Jump without animating: a different conversation, a resize, an anchored repaint. */
  snap(logical: number): void {
    this.target = this.grid = logical;
    this.terms = [];
    this.unsent = [];
    this.base = 0;
    this.gridValid = false;
    this.expectedShift = 0;
    this.pendingReset = this.terminalNonzero;
    this.pendingDelta = this.pendingEase = 0;
  }

  /**
   * The whole offset to lay this frame out at. `logical` is the clamped
   * scrollOffset after this frame's adjustments; `pinDelta` is how far
   * pinning moved it to keep the same content on screen (not a scroll).
   * A different `context` (conversation, pane size) starts over without
   * animating.
   */
  layout(logical: number, maxOffset: number, pinDelta: number, height: number, context: string): number {
    const time = this.now();
    this.height = height;
    this.maxOffset = maxOffset;
    if (context !== this.context) {
      this.context = context;
      this.gridValid = false;
    }
    if (pinDelta !== 0) {
      this.target += pinDelta;
      this.grid += pinDelta;
    }
    if (!this.gridValid) {
      this.snap(logical);
      this.gridValid = true;
      return logical;
    }
    this.prune(time);
    if (logical !== this.target) {
      const position = this.grid + this.offsetAt(time);
      const step = logical - this.target;
      this.target = logical;
      if (Math.abs(logical - position) > height) {
        // Jumps further than a screen glide in from one screen away.
        this.restart(logical - Math.sign(logical - position) * height, time);
      } else {
        this.base += step;
        this.pendingDelta += step;
        this.addTerm(-step, time);
      }
    }
    const grid = this.gridFor(time, maxOffset);
    this.expectedShift = this.grid - grid;
    this.base -= grid - this.grid;
    this.pendingDelta -= grid - this.grid;
    this.grid = grid;
    return grid;
  }

  private maxOffset = 0;

  /**
   * After the frame was flushed: `regionShift` is how far its region scroll
   * moved the content (up positive, 0 when it was repainted). Returns what to
   * send inside the same synchronized update (rectangles, motion).
   */
  afterFlush(regionShift: number, rects: readonly ScrollRect[]): string {
    const time = this.now();
    if (this.expectedShift !== 0 && regionShift === 0) {
      // Repainted, not scrolled: nothing on screen to glide from; ease on from here.
      this.restart(this.grid, time);
    } else if (regionShift !== this.expectedShift) {
      // Content moved by itself (output while following): ease it from where it was.
      const moved = regionShift - this.expectedShift;
      this.addTerm(moved, time);
    }
    this.expectedShift = 0;
    if (rects.length === 0 || Math.abs(this.offsetAt(time)) >= Math.max(1, this.height - 1)) {
      // Nothing to move, or further than the lines the terminal keeps.
      this.restart(this.grid, time);
      this.terms = [];
      this.unsent = [];
      this.pendingEase = 0;
    }
    let out = "";
    const rectKey = rectsPayload(rects);
    if (rectKey !== this.sentRects) {
      out += rectKey;
      this.sentRects = rectKey;
    }
    return out + this.takeMotion();
  }

  private takeMotion(): string {
    let out = "";
    // `o` starts over from the base before this frame's moves.
    if (this.pendingReset) out += offsetPayload(Math.round((this.base - this.pendingDelta) * 1000));
    if (this.pendingDelta !== 0 || this.pendingEase !== 0) out += movePayload(this.pendingDelta, this.pendingEase, this.durationMs);
    const sentAt = this.now();
    for (const term of this.unsent) term.start = sentAt;
    this.unsent = [];
    this.pendingReset = false;
    this.pendingDelta = this.pendingEase = 0;
    this.terminalNonzero = this.base !== 0 || this.terms.length > 0;
    return out;
  }

  /** The animation crosses a row: lay the next frame out. */
  needsLayout(): boolean {
    return this.gridValid && this.gridFor(this.now(), this.maxOffset) !== this.grid;
  }

  /** Frames (row crossings) may still be needed. */
  busy(): boolean {
    this.prune(this.now());
    return this.gridValid && (this.terms.length > 0 || this.grid !== this.target);
  }

  /** The terminal dropped its state (resize, screen switch): send it again. */
  terminalReset(): void {
    this.sentRects = "";
    this.terminalNonzero = false;
  }
}

const scrollers = new WeakMap<object, SmoothScroller>();

/** Attach (or with null, detach) app-driven smooth scrolling to a render state. */
export function setSmoothScroller(owner: object, scroller: SmoothScroller | null): void {
  if (scroller) scrollers.set(owner, scroller);
  else scrollers.delete(owner);
}

export function smoothScrollerFor(owner: object): SmoothScroller | null {
  return scrollers.get(owner) ?? null;
}
