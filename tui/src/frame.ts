/**
 * Retained terminal frame flushing.
 *
 * The high-level renderer builds a desired row payload for every terminal row.
 * This module compares that desired frame with the previously flushed frame and
 * emits only the terminal operations needed to reach it.
 */

export const ESC = "\x1b[";
export const clearLine = `${ESC}2K`;
export const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`;

const beginSynchronizedUpdate = `${ESC}?2026h`;
const endSynchronizedUpdate = `${ESC}?2026l`;

export interface ScrollRegion {
  start: number;
  end: number;
}

export interface RenderFrame {
  /** Full-row redraw payloads, indexed by zero-based screen row. */
  rows: string[];
  /** Cursor position/shape/visibility payload emitted after row updates. */
  cursor: string;
  /** Optional message-area region eligible for terminal scroll optimization. */
  scrollRegion: ScrollRegion | null;
  /** First history line visible in the message area. Used to detect scrolls. */
  viewStart: number;
}

const lastRenderedFrames = new WeakMap<object, RenderFrame>();

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

function scrollUpRegion(region: ScrollRegion, amount: number): string {
  // DECSTBM + LF at the bottom margin scrolls only the message region. This is
  // supported by the Linux console and common terminal emulators.
  return `${ESC}${region.start};${region.end}r${moveTo(region.end, 1)}${"\n".repeat(amount)}${ESC}r`;
}

function detectUpwardScroll(prevFrame: RenderFrame, nextFrame: RenderFrame): number {
  if (!sameScrollRegion(prevFrame.scrollRegion, nextFrame.scrollRegion)) return 0;
  const region = nextFrame.scrollRegion;
  if (!region) return 0;

  const viewportShift = nextFrame.viewStart - prevFrame.viewStart;
  if (viewportShift <= 0) return 0;

  const height = region.end - region.start + 1;
  if (height < 4) return 0;

  const maxShift = Math.min(10, Math.floor(height / 2), viewportShift);
  let bestShift = 0;
  let bestMatches = 0;

  for (let shift = viewportShift; shift <= maxShift; shift++) {
    let matches = 0;
    for (let row = region.start - 1; row <= region.end - 1 - shift; row++) {
      if (sameRowContent(prevFrame.rows[row + shift], nextFrame.rows[row])) matches++;
    }

    const comparableRows = height - shift;
    const threshold = Math.max(3, Math.floor(comparableRows * 0.6));
    if (matches >= threshold && matches > bestMatches) {
      bestShift = shift;
      bestMatches = matches;
    }
  }

  return bestShift;
}

/** Flush only the rows/cursor state that changed since the previous frame. */
export function flushFrame(owner: object, nextFrame: RenderFrame): void {
  const prevFrame = lastRenderedFrames.get(owner);
  const out: string[] = [];
  const rowCount = Math.max(prevFrame?.rows.length ?? 0, nextFrame.rows.length);
  const scrollShift = prevFrame ? detectUpwardScroll(prevFrame, nextFrame) : 0;
  const scrollRegion = scrollShift > 0 ? nextFrame.scrollRegion : null;

  if (scrollRegion) {
    out.push(scrollUpRegion(scrollRegion, scrollShift));
  }

  for (let i = 0; i < rowCount; i++) {
    const nextRow = nextFrame.rows[i];
    if (nextRow === undefined) continue;

    let unchanged = prevFrame?.rows[i] === nextRow;
    if (scrollRegion && i >= scrollRegion.start - 1 && i <= scrollRegion.end - 1) {
      const shiftedPrevRow = i + scrollShift <= scrollRegion.end - 1 ? prevFrame?.rows[i + scrollShift] : undefined;
      unchanged = sameRowContent(shiftedPrevRow, nextRow);
    }

    if (!unchanged) out.push(nextRow);
  }

  if (out.length > 0 || !prevFrame || prevFrame.cursor !== nextFrame.cursor) {
    out.push(nextFrame.cursor);
  }

  if (out.length > 0) {
    // Terminals that support synchronized updates (most modern GUI emulators)
    // will present multi-row diffs atomically. Unsupported terminals, including
    // the Linux virtual console, ignore the DEC private mode sequences.
    if (out.length > 2) process.stdout.write(beginSynchronizedUpdate + out.join("") + endSynchronizedUpdate);
    else process.stdout.write(out.join(""));
  }

  lastRenderedFrames.set(owner, nextFrame);
}
