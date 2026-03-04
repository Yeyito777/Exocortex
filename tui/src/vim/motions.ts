/**
 * Vim motions — pure functions.
 *
 * Each motion takes (buffer, cursorPos) and returns a new cursorPos.
 * No side effects, no state. Easy to test, easy to compose with operators.
 */

// ── Character classification ───────────────────────────────────────

function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function isPunct(ch: string): boolean {
  return !isWordChar(ch) && !isSpace(ch);
}

// ── Line helpers ───────────────────────────────────────────────────

function lineStartOf(buffer: string, pos: number): number {
  const idx = buffer.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

function lineEndOf(buffer: string, pos: number): number {
  const idx = buffer.indexOf("\n", pos);
  return idx === -1 ? buffer.length : idx;
}

// ── Character motions ──────────────────────────────────────────────

export function charLeft(_buffer: string, pos: number): number {
  return Math.max(0, pos - 1);
}

export function charRight(buffer: string, pos: number): number {
  return Math.min(buffer.length, pos + 1);
}

// ── Word motions ───────────────────────────────────────────────────

/** w — move to start of next word. */
export function wordForward(buffer: string, pos: number): number {
  const len = buffer.length;
  if (pos >= len) return pos;
  let i = pos;

  // Skip current word or punctuation block
  if (isWordChar(buffer[i])) {
    while (i < len && isWordChar(buffer[i])) i++;
  } else if (isPunct(buffer[i])) {
    while (i < len && isPunct(buffer[i])) i++;
  } else {
    i++;
  }

  // Skip whitespace
  while (i < len && isSpace(buffer[i])) i++;

  return i;
}

/** b — move to start of previous word. */
export function wordBackward(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  // Skip whitespace backwards
  while (i > 0 && isSpace(buffer[i])) i--;

  // Skip current word or punctuation block backwards
  if (i >= 0 && isWordChar(buffer[i])) {
    while (i > 0 && isWordChar(buffer[i - 1])) i--;
  } else if (i >= 0 && isPunct(buffer[i])) {
    while (i > 0 && isPunct(buffer[i - 1])) i--;
  }

  return Math.max(0, i);
}

/** e — move to end of current/next word. */
export function wordEnd(buffer: string, pos: number): number {
  const len = buffer.length;
  if (pos >= len - 1) return Math.max(0, len - 1);
  let i = pos + 1;

  // Skip whitespace
  while (i < len && isSpace(buffer[i])) i++;

  // Skip word or punctuation block
  if (i < len && isWordChar(buffer[i])) {
    while (i < len - 1 && isWordChar(buffer[i + 1])) i++;
  } else if (i < len && isPunct(buffer[i])) {
    while (i < len - 1 && isPunct(buffer[i + 1])) i++;
  }

  return i;
}

// ── Line motions ───────────────────────────────────────────────────

/** 0 — move to start of current line. */
export function lineStart(buffer: string, pos: number): number {
  return lineStartOf(buffer, pos);
}

/** $ — move to end of current line. */
export function lineEnd(buffer: string, pos: number): number {
  return lineEndOf(buffer, pos);
}

/** j — move down one line, preserving column. */
export function lineDown(buffer: string, pos: number): number {
  const ls = lineStartOf(buffer, pos);
  const col = pos - ls;
  const le = lineEndOf(buffer, pos);

  // No next line
  if (le >= buffer.length) return pos;

  const nextLs = le + 1;
  const nextLe = lineEndOf(buffer, nextLs);
  const nextLineLen = nextLe - nextLs;

  return nextLs + Math.min(col, nextLineLen);
}

/** k — move up one line, preserving column. */
export function lineUp(buffer: string, pos: number): number {
  const ls = lineStartOf(buffer, pos);

  // No previous line
  if (ls === 0) return pos;

  const col = pos - ls;
  const prevLe = ls - 1; // \n before current line
  const prevLs = lineStartOf(buffer, prevLe);
  const prevLineLen = prevLe - prevLs;

  return prevLs + Math.min(col, prevLineLen);
}

// ── Buffer-level motions ───────────────────────────────────────────

/** gg — move to start of buffer. */
export function bufferStart(): number {
  return 0;
}

/** G — move to end of buffer. */
export function bufferEnd(buffer: string): number {
  return buffer.length;
}

// ── Motion registry ────────────────────────────────────────────────

/** Look up a motion function by name. Returns null if unknown. */
export function resolveMotion(name: string): ((buffer: string, pos: number) => number) | null {
  switch (name) {
    case "char_left":     return charLeft;
    case "char_right":    return charRight;
    case "word_forward":  return wordForward;
    case "word_backward": return wordBackward;
    case "word_end":      return wordEnd;
    case "line_start":    return lineStart;
    case "line_end":      return lineEnd;
    case "line_down":     return lineDown;
    case "line_up":       return lineUp;
    case "buffer_start":  return (_buf, _pos) => bufferStart();
    case "buffer_end":    return (buf, _pos) => bufferEnd(buf);
    default:              return null;
  }
}
