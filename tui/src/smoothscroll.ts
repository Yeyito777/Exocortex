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
/** Animation frames while something moves (~120 Hz). */
export const SMOOTH_SCROLL_FRAME_MS = 8;

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

/**
 * Scroll animation in scrollOffset units (rows from the bottom; larger is
 * older history, so content moves down on screen as it grows).
 *
 * `position` eases from where the view is towards the logical offset. The
 * history is laid out at a whole offset next to it, on the far side in the
 * direction of travel, so the terminal only ever needs the lines its own
 * region scrolls pushed out to fill the gap. Content that moved for other
 * reasons (streamed output while following, rows laid out above) glides from
 * where it was drawn.
 */
export class SmoothScroller {
  private target = 0;
  private from = 0;
  private start = 0;
  private moving = false;
  /** Whole offset of the last laid-out frame. */
  private grid = 0;
  private gridValid = false;
  /** Rows (down positive) the content still lags behind a shift it made by itself. */
  private glideFrom = 0;
  private glideStart = 0;
  /** Region shift (up positive) the last layout step makes. */
  private expectedShift = 0;
  private height = 0;
  private sentOffset = 0;
  private sentRects = "";
  private context: string | null = null;

  constructor(
    private readonly durationMs = SMOOTH_SCROLL_DURATION_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private position(time: number): number {
    if (!this.moving) return this.target;
    const remaining = easeRemaining((time - this.start) / this.durationMs);
    if (remaining === 0) return this.target;
    return this.target + (this.from - this.target) * remaining;
  }

  private glide(time: number): number {
    if (this.glideFrom === 0) return 0;
    return this.glideFrom * easeRemaining((time - this.glideStart) / this.durationMs);
  }

  private gridFor(position: number): number {
    if (position === this.target) return this.target;
    return this.target > position ? Math.ceil(position) : Math.floor(position);
  }

  /** Jump without animating: a different conversation, a resize, an anchored repaint. */
  snap(logical: number): void {
    this.target = this.from = this.grid = logical;
    this.moving = false;
    this.glideFrom = 0;
    this.gridValid = false;
    this.expectedShift = 0;
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
    if (context !== this.context) {
      this.context = context;
      this.gridValid = false;
    }
    if (pinDelta !== 0) {
      this.target += pinDelta;
      this.from += pinDelta;
      this.grid += pinDelta;
    }
    if (!this.gridValid) {
      this.snap(logical);
      this.gridValid = true;
      this.expectedShift = 0;
      return logical;
    }
    if (logical !== this.target) {
      let position = this.position(time);
      // Jumps further than a screen glide in from one screen away.
      if (Math.abs(logical - position) > height) position = logical - Math.sign(logical - position) * height;
      this.from = position;
      this.start = time;
      this.target = logical;
      this.moving = true;
    }
    const position = this.position(time);
    if (position === this.target) this.moving = false;
    const grid = Math.max(0, Math.min(maxOffset, this.gridFor(position)));
    this.expectedShift = this.grid - grid;
    this.grid = grid;
    return grid;
  }

  /**
   * After the frame was flushed: `regionShift` is how far its region scroll
   * moved the content (up positive, 0 when it was repainted). Returns what to
   * send inside the same synchronized update (rectangles, offset).
   */
  afterFlush(regionShift: number, rects: readonly ScrollRect[]): string {
    const time = this.now();
    if (this.expectedShift !== 0 && regionShift === 0) {
      // Repainted, not scrolled: there is nothing on screen to glide.
      this.from = this.grid;
      this.start = time;
      this.glideFrom = 0;
    } else if (regionShift !== this.expectedShift) {
      // Content moved by itself (output while following): draw it where it was.
      this.glideFrom = this.glide(time) + (regionShift - this.expectedShift);
      this.glideStart = time;
    }
    this.expectedShift = 0;
    let out = "";
    const rectKey = rectsPayload(rects);
    if (rectKey !== this.sentRects) {
      out += rectKey;
      this.sentRects = rectKey;
    }
    let offset = this.offsetAt(time);
    if (rects.length === 0 || Math.abs(offset) >= Math.max(1, this.height - 1)) {
      // Nothing to move, or further than the lines the terminal kept.
      this.from = this.grid;
      this.start = time;
      this.glideFrom = 0;
      offset = this.offsetAt(time);
    }
    return out + this.offsetUpdate(offset);
  }

  private offsetAt(time: number): number {
    return this.position(time) - this.grid + this.glide(time);
  }

  private offsetUpdate(offset: number): string {
    const thousandths = Math.round(offset * 1000);
    if (thousandths === this.sentOffset) return "";
    this.sentOffset = thousandths;
    return offsetPayload(thousandths);
  }

  /** The next animation frame needs a new layout (it crosses a row). */
  needsLayout(): boolean {
    const time = this.now();
    return this.gridFor(this.position(time)) !== this.grid;
  }

  /** Offset-only frame: what to send, possibly nothing. */
  tick(): string {
    return this.offsetUpdate(this.offsetAt(this.now()));
  }

  /** Frames are still needed. */
  busy(): boolean {
    const time = this.now();
    if (this.moving && this.position(time) === this.target) this.moving = false;
    if (this.glideFrom !== 0 && this.glide(time) === 0) this.glideFrom = 0;
    return this.moving || this.glideFrom !== 0 || this.sentOffset !== 0;
  }

  /** The terminal dropped its state (resize, screen switch): send it again. */
  terminalReset(): void {
    this.sentOffset = 0;
    this.sentRects = "";
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
