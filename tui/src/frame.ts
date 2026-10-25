/**
 * Retained terminal frame flushing.
 *
 * The high-level renderer builds a desired row payload for every terminal row.
 * This module compares that desired frame with the previously flushed frame and
 * emits only the terminal operations needed to reach it.
 *
 * When the message area's content moved by a few rows, the flush asks the
 * terminal to scroll just that band (DECSTBM + SU/SD) and then draws only the
 * rows the scroll could not supply. `tui.scrollRegions: false` in config.json
 * restores the older, narrower optimization (no sidebar, no images, LF/RI).
 */

import { readExocortexConfig } from "@exocortex/shared/config";

export const ESC = "\x1b[";
export const clearLine = `${ESC}2K`;
export const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

const beginSynchronizedUpdate = `${ESC}?2026h`;
const endSynchronizedUpdate = `${ESC}?2026l`;
const hideCursor = `${ESC}?25l`;

export interface ScrollRegion {
  start: number;
  end: number;
}

export interface RenderFrame {
  /** Full-row redraw payloads, indexed by zero-based screen row. */
  rows: string[];
  /**
   * Per-row segment, already part of `rows[i]`, that paints columns beside the
   * scrolled content (the sidebar). A region scroll moves whole rows (st has
   * no left/right margins), so rows whose other content moved intact get only
   * this segment repainted. Nothing else in the row may draw over its columns.
   */
  pinned?: (string | undefined)[];
  /** Cursor position/shape/visibility payload emitted after row updates. */
  cursor: string;
  /** Optional message-area region eligible for terminal scroll optimization. */
  scrollRegion: ScrollRegion | null;
  /** First history line visible in the message area. Used to detect scrolls. */
  viewStart: number;
  /**
   * Terminal graphics commands (image placements) applied with this frame. A
   * function learns whether the message region scrolled first: terminals move
   * or drop placements with the rows they sit on.
   */
  graphics?: string | ((regionScrolled: boolean) => string);
  /**
   * Sent last inside the same synchronized update, given how far the region
   * scroll moved the content (up positive, 0 without one) and whether every
   * row it moved arrived intact (nothing else changed): app-driven smooth
   * scrolling's rectangles and offset (smoothscroll.ts).
   */
  afterScroll?: (regionShift: number, intact: boolean) => string;
}

interface RetainedFrame extends RenderFrame {
  /** Lazily computed content keys (see `contentKey`), by row. */
  keys?: (string | undefined)[];
}

const lastRenderedFrames = new WeakMap<object, RetainedFrame>();

// ── tui.scrollRegions ───────────────────────────────────────────────

let scrollRegionsSetting: boolean | null = null;

/** config.json `tui.scrollRegions`; anything but `false` means on. */
export function resolveScrollRegionsSetting(
  readConfig: () => { tui?: { scrollRegions?: unknown } } = readExocortexConfig,
): boolean {
  try {
    return readConfig().tui?.scrollRegions !== false;
  } catch {
    return true;
  }
}

/** Whether message-area scrolls use full region scrolls (read once per process). */
export function scrollRegionsEnabled(): boolean {
  return scrollRegionsSetting ??= resolveScrollRegionsSetting();
}

/** Override the setting (tests); null re-reads config.json on next use. */
export function setScrollRegionsEnabled(enabled: boolean | null): void {
  scrollRegionsSetting = enabled;
}

/**
 * Forget the retained frame for an owner so the next flush repaints every row.
 *
 * This is required after terminal resize/expose events: even if a row's desired
 * payload bytes are unchanged, the terminal backing grid may contain newly
 * exposed stale cells that only get cleared if we re-emit the row's clear-line
 * sequence at the new geometry.
 */
export function invalidateFrame(owner: object): void {
  lastRenderedFrames.delete(owner);
}

export function createFrameRows(totalRows: number, clearPayload: string): string[] {
  return Array.from({ length: totalRows }, (_, i) => moveTo(i + 1, 1) + clearPayload);
}

export function appendRowWrite(frameRows: string[], row: number, col: number, text: string): void {
  if (row < 1 || row > frameRows.length) return;
  frameRows[row - 1] += moveTo(row, col) + text;
}

/**
 * Adapt legacy overlay renderers that already return cursor-positioned ANSI.
 * Splits the payload by absolute cursor moves and appends each span to the
 * corresponding retained row.
 */
export function appendPositionedPayload(frameRows: string[], payload: string): void {
  const moveRe = /\x1b\[(\d+);(\d+)H/g;
  let currentRow: number | null = null;
  let currentCol: number | null = null;
  let lastEnd = 0;

  for (let match = moveRe.exec(payload); match !== null; match = moveRe.exec(payload)) {
    if (currentRow !== null && currentCol !== null && currentRow >= 1 && currentRow <= frameRows.length) {
      frameRows[currentRow - 1] += moveTo(currentRow, currentCol) + payload.slice(lastEnd, match.index);
    }
    currentRow = Number(match[1]);
    currentCol = Number(match[2]);
    lastEnd = moveRe.lastIndex;
  }

  if (currentRow !== null && currentCol !== null && currentRow >= 1 && currentRow <= frameRows.length) {
    frameRows[currentRow - 1] += moveTo(currentRow, currentCol) + payload.slice(lastEnd);
  }
}

function normalizeRowMoves(row: string | undefined): string | undefined {
  return row?.replace(/\x1b\[\d+;(\d+)H/g, "\x1b[ROW;$1H");
}

function sameRowContent(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeRowMoves(a) === normalizeRowMoves(b);
}

function sameScrollRegion(a: ScrollRegion | null, b: ScrollRegion | null): a is ScrollRegion {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

function scrollRegionBy(region: ScrollRegion, amount: number, singleSequence: boolean): string {
  // DECSTBM confines the scroll to the message region. SU/SD move it by
  // `amount` rows in one operation, which a smooth-scrolling terminal can
  // animate as one glide. The Linux console lacks SU/SD, so it (and the legacy
  // mode) use LF at the bottom margin / reverse index (RI) at the top margin.
  const scroll = singleSequence
    ? `${ESC}${Math.abs(amount)}${amount > 0 ? "S" : "T"}`
    : amount > 0
      ? moveTo(region.end, 1) + "\n".repeat(amount)
      : moveTo(region.start, 1) + "\x1bM".repeat(-amount);
  return `${ESC}${region.start};${region.end}r${scroll}${ESC}r`;
}

function terminalHasScrollSequences(): boolean {
  return !(process.env.TERM ?? "").startsWith("linux");
}

/** A row's payload without its pinned segment, with absolute row numbers removed. */
function contentKey(frame: RetainedFrame, index: number): string | undefined {
  const keys = frame.keys ??= [];
  if (index in keys) return keys[index];
  const row = frame.rows[index];
  const pinned = frame.pinned?.[index];
  const at = row !== undefined && pinned ? row.indexOf(pinned) : -1;
  const key = normalizeRowMoves(at < 0 ? row : row!.slice(0, at) + row!.slice(at + pinned!.length));
  keys[index] = key;
  return key;
}

/**
 * What row `i` of a scrolled region needs: nothing, only its pinned segment
 * (the content beside it moved intact), or the whole row.
 */
function scrolledRowUpdate(
  prevFrame: RetainedFrame,
  nextFrame: RetainedFrame,
  region: ScrollRegion,
  index: number,
  shift: number,
): string | null {
  const nextRow = nextFrame.rows[index];
  const source = index + shift;
  if (source < region.start - 1 || source > region.end - 1) return nextRow;
  const key = contentKey(nextFrame, index);
  if (key === undefined || key !== contentKey(prevFrame, source)) return nextRow;
  const nextPinned = nextFrame.pinned?.[index];
  const prevPinned = prevFrame.pinned?.[source];
  if (!nextPinned && !prevPinned) return null;
  if (!nextPinned || !prevPinned) return nextRow;
  return sameRowContent(prevPinned, nextPinned) ? null : nextPinned;
}

/**
 * Rows the message region's content moved since the previous frame: positive
 * when it moved up (viewport toward newer history), negative when it moved down
 * (scrolling back), 0 when terminal scrolling would not save enough redraws.
 * `same(prevIndex, nextIndex)` says whether two rows count as the same content.
 * The move must equal the change of the first visible history line.
 */
function detectRegionScroll(
  prevFrame: RenderFrame,
  nextFrame: RenderFrame,
  same: (prevIndex: number, nextIndex: number) => boolean,
): number {
  if (!sameScrollRegion(prevFrame.scrollRegion, nextFrame.scrollRegion)) return 0;
  const region = nextFrame.scrollRegion;
  if (!region) return 0;

  const viewportShift = nextFrame.viewStart - prevFrame.viewStart;
  if (viewportShift === 0) return 0;
  const direction = Math.sign(viewportShift);

  const height = region.end - region.start + 1;
  if (height < 4) return 0;

  // Half-page jumps still reuse the other half of the region.
  const maxShift = Math.min(height - 3, Math.abs(viewportShift));
  let bestShift = 0;
  let bestMatches = 0;

  for (let shift = Math.abs(viewportShift); shift <= maxShift; shift++) {
    let matches = 0;
    for (let row = region.start - 1; row <= region.end - 1 - shift; row++) {
      if (direction > 0 ? same(row + shift, row) : same(row, row + shift)) matches++;
    }

    const comparableRows = height - shift;
    const threshold = Math.max(3, Math.floor(comparableRows * 0.6));
    if (matches >= threshold && matches > bestMatches) {
      bestShift = shift;
      bestMatches = matches;
    }
  }

  return bestShift * direction;
}

/**
 * How far the message region's content moved, found from the rows themselves:
 * the shift that explains the most rows that changed. Used when the
 * viewport's own move does not explain the frame: the first visible line's
 * index also jumps when older history is prepended (pages loaded over /ssh)
 * or more of it is laid out, while the content on screen moved by just the
 * scroll step. Sign as above.
 */
function detectContentScroll(
  prevFrame: RenderFrame,
  nextFrame: RenderFrame,
  same: (prevIndex: number, nextIndex: number) => boolean,
): number {
  if (!sameScrollRegion(prevFrame.scrollRegion, nextFrame.scrollRegion)) return 0;
  const region = nextFrame.scrollRegion;
  if (!region) return 0;
  const height = region.end - region.start + 1;
  if (height < 4) return 0;

  // Unchanged rows (blank lines, a still sidebar-only row) say nothing.
  const first = region.start - 1;
  const last = region.end - 1;
  const changed: number[] = [];
  for (let row = first; row <= last; row++) if (!same(row, row)) changed.push(row);
  if (changed.length < 3) return 0;

  const hint = nextFrame.viewStart - prevFrame.viewStart;
  let best = 0;
  let bestMatches = 0;
  for (let distance = 1; distance <= height - 3; distance++) {
    for (const direction of [1, -1]) {
      const shift = distance * direction;
      let comparable = 0;
      let matches = 0;
      for (const row of changed) {
        const source = row + shift;
        if (source < first || source > last) continue;
        comparable++;
        if (same(source, row)) matches++;
      }
      if (matches < Math.max(3, Math.floor(comparable * 0.6))) continue;
      // Most rows explained wins; on a tie the viewport's own move, else the shorter one.
      if (matches > bestMatches || (matches === bestMatches && shift === hint)) {
        best = shift;
        bestMatches = matches;
      }
    }
  }
  return best;
}

/** Flush only the rows/cursor state that changed since the previous frame. */
export function flushFrame(owner: object, nextFrame: RenderFrame): void {
  const prevFrame = lastRenderedFrames.get(owner);
  const next: RetainedFrame = { ...nextFrame };
  const out: string[] = [];
  const rowCount = Math.max(prevFrame?.rows.length ?? 0, nextFrame.rows.length);
  const regions = scrollRegionsEnabled();
  // Compare without the sidebar, which stays put while the content moves.
  const sameContent = (prevIndex: number, nextIndex: number) => {
    const key = contentKey(next, nextIndex);
    return key !== undefined && key === contentKey(prevFrame!, prevIndex);
  };
  const scrollShift = !prevFrame ? 0 : regions
    ? detectRegionScroll(prevFrame, next, sameContent) || detectContentScroll(prevFrame, next, sameContent)
    : detectRegionScroll(prevFrame, next, (prevIndex, nextIndex) => sameRowContent(prevFrame.rows[prevIndex], next.rows[nextIndex]));
  const scrollRegion = scrollShift !== 0 ? nextFrame.scrollRegion : null;
  let hasDrawingUpdates = false;
  /** Every row the region scroll supplied matches this frame (near the bottom edge aside). */
  let scrolledIntact = scrollRegion !== null;

  if (scrollRegion) {
    out.push(scrollRegionBy(scrollRegion, scrollShift, regions && terminalHasScrollSequences()));
    hasDrawingUpdates = true;
  }

  for (let i = 0; i < rowCount; i++) {
    const nextRow = nextFrame.rows[i];
    if (nextRow === undefined) continue;

    if (scrollRegion && regions && prevFrame && i >= scrollRegion.start - 1 && i <= scrollRegion.end - 1) {
      const update = scrolledRowUpdate(prevFrame, next, scrollRegion, i, scrollShift);
      const source = i + scrollShift;
      // The two rows above the ones it exposed may change with it (the
      // footer of what was the last message, a streamed reply's live rows).
      if (update === nextRow && source >= scrollRegion.start - 1 && source <= scrollRegion.end - 1
        && i < scrollRegion.end - 1 - Math.abs(scrollShift) - 2) scrolledIntact = false;
      if (update !== null) {
        out.push(update);
        hasDrawingUpdates = true;
      }
      continue;
    }

    let unchanged = prevFrame?.rows[i] === nextRow;
    if (scrollRegion && i >= scrollRegion.start - 1 && i <= scrollRegion.end - 1) {
      // The terminal now shows the previous frame's row i + shift here (or a
      // blank row where scrolling exposed one).
      const source = i + scrollShift;
      const shiftedPrevRow = source >= scrollRegion.start - 1 && source <= scrollRegion.end - 1
        ? prevFrame?.rows[source]
        : undefined;
      unchanged = sameRowContent(shiftedPrevRow, nextRow);
    }

    if (!unchanged) {
      out.push(nextRow);
      hasDrawingUpdates = true;
    }
  }

  // Images draw above text, so placing them after the rows is equivalent and
  // keeps both inside the same synchronized update.
  const graphics = typeof nextFrame.graphics === "function"
    ? nextFrame.graphics(scrollRegion !== null)
    : nextFrame.graphics;
  if (graphics) {
    out.push(graphics);
    hasDrawingUpdates = true;
  }

  const smooth = nextFrame.afterScroll?.(scrollShift, scrolledIntact);
  if (smooth) out.push(smooth);

  if (out.length > 0 || !prevFrame || prevFrame.cursor !== nextFrame.cursor) {
    out.push(nextFrame.cursor);
  }

  if (out.length > 0) {
    const payload = out.join("");
    // Terminals that support synchronized updates (most modern GUI emulators)
    // will present multi-row diffs atomically. Unsupported terminals, including
    // the Linux virtual console, ignore the DEC private mode sequences.
    if (hasDrawingUpdates) process.stdout.write(beginSynchronizedUpdate + hideCursor + payload + endSynchronizedUpdate);
    else process.stdout.write(payload);
  }

  next.graphics = undefined;
  next.afterScroll = undefined;
  lastRenderedFrames.set(owner, next);
}
