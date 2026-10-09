/**
 * Vim motions — pure functions.
 *
 * Each motion takes (buffer, cursorPos) and returns a new cursorPos.
 * No side effects, no state. Easy to test, easy to compose with operators.
 */

import { lineStartOf, lineEndOf, nextGraphemeEnd, previousGraphemeStart } from "./buffer";
import { isWordChar, isBufferSpace as isSpace, isPunct } from "../chars";

// ── Character motions ──────────────────────────────────────────────

function normalLineEnd(buffer: string, pos: number): number {
  const start = lineStartOf(buffer, pos);
  const end = lineEndOf(buffer, pos);
  return end > start ? previousGraphemeStart(buffer, end) : end;
}

export function charLeft(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  // Don't cross newline boundary
  if (buffer[pos - 1] === "\n") return pos;
  return previousGraphemeStart(buffer, pos);
}

export function charRight(buffer: string, pos: number): number {
  if (pos >= buffer.length) return buffer.length;
  const next = nextGraphemeEnd(buffer, pos);
  // Don't move onto the newline delimiter at the end of a non-empty line.
  return next > normalLineEnd(buffer, pos) ? pos : next;
}

// ── Word motions ───────────────────────────────────────────────────

/** True when `pos` is on an empty line, where Vim's w/W/b/B stop. */
function isEmptyLineAt(buffer: string, pos: number): boolean {
  return (pos === 0 || buffer[pos - 1] === "\n") && (pos === buffer.length || buffer[pos] === "\n");
}

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

  // Skip whitespace, stopping at an empty line
  while (i < len && isSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i++;

  return i;
}

/** b — move to start of previous word. */
export function wordBackward(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  // Skip whitespace backwards, stopping at an empty line
  while (i > 0 && isSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i--;

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

// ── WORD motions (whitespace-delimited) ────────────────────────────

/** W — move to start of next WORD. */
export function wordForwardBig(buffer: string, pos: number): number {
  const len = buffer.length;
  let i = pos;

  // Skip current non-whitespace
  while (i < len && !isSpace(buffer[i])) i++;

  // Skip whitespace, stopping at an empty line
  while (i < len && isSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i++;

  return i;
}

/** B — move to start of previous WORD. */
export function wordBackwardBig(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;

  // Skip whitespace backwards, stopping at an empty line
  while (i > 0 && isSpace(buffer[i]) && !isEmptyLineAt(buffer, i)) i--;

  // Skip non-whitespace backwards
  while (i > 0 && !isSpace(buffer[i - 1])) i--;

  return Math.max(0, i);
}

/** E — move to end of current/next WORD. */
export function wordEndBig(buffer: string, pos: number): number {
  const len = buffer.length;
  if (pos >= len - 1) return Math.max(0, len - 1);
  let i = pos + 1;

  // Skip whitespace
  while (i < len && isSpace(buffer[i])) i++;

  // Skip non-whitespace
  while (i < len - 1 && !isSpace(buffer[i + 1])) i++;

  return i;
}

// ── Line motions ───────────────────────────────────────────────────

/** 0 — move to start of current line. */
export function lineStart(buffer: string, pos: number): number {
  return lineStartOf(buffer, pos);
}

/** ^ — move to the first non-blank character of the current line. */
export function firstNonBlank(buffer: string, pos: number): number {
  const end = lineEndOf(buffer, pos);
  let i = lineStartOf(buffer, pos);
  while (i < end && (buffer[i] === " " || buffer[i] === "\t")) i++;
  return i;
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

// ── Find motions (f/F/t/T) ─────────────────────────────────────────

export type FindKind = "f" | "F" | "t" | "T";

/** The opposite-direction find, for `,`. */
export function reverseFindKind(kind: FindKind): FindKind {
  return ({ f: "F", F: "f", t: "T", T: "t" } as const)[kind];
}

/**
 * f/F/t/T{char} — the next/previous `char` on the current line, or just
 * before/after it for t/T. Returns null when there is no match. A repeat
 * (; and ,) skips a t/T match right next to the cursor, so it can't get stuck.
 */
export function findChar(buffer: string, pos: number, char: string, kind: FindKind, repeat = false): number | null {
  const till = kind === "t" || kind === "T";
  if (kind === "f" || kind === "t") {
    const end = lineEndOf(buffer, pos);
    let i = nextGraphemeEnd(buffer, pos);
    if (till && repeat && i < end) i = nextGraphemeEnd(buffer, i);
    for (; i < end; i = nextGraphemeEnd(buffer, i)) {
      if (buffer.startsWith(char, i)) return till ? previousGraphemeStart(buffer, i) : i;
    }
    return null;
  }

  const start = lineStartOf(buffer, pos);
  let i = pos;
  if (till && repeat && i > start) i = previousGraphemeStart(buffer, i);
  while (i > start) {
    i = previousGraphemeStart(buffer, i);
    if (buffer.startsWith(char, i)) return till ? nextGraphemeEnd(buffer, i) : i;
  }
  return null;
}

/** findChar repeated `count` times (2fx, 3;); null unless every repetition matches. */
export function findCharCount(
  buffer: string, pos: number, char: string, kind: FindKind, count: number, repeat = false,
): number | null {
  let target: number | null = pos;
  for (let i = 0; i < count && target !== null; i++) {
    target = findChar(buffer, target, char, kind, repeat || i > 0);
  }
  return target;
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
    case "word_forward":      return wordForward;
    case "word_backward":     return wordBackward;
    case "word_end":          return wordEnd;
    case "word_forward_big":  return wordForwardBig;
    case "word_backward_big": return wordBackwardBig;
    case "word_end_big":      return wordEndBig;
    case "line_start":    return lineStart;
    case "first_non_blank": return firstNonBlank;
    case "line_end":      return lineEnd;
    case "line_down":     return lineDown;
    case "line_up":       return lineUp;
    case "buffer_start":  return (_buf, _pos) => bufferStart();
    case "buffer_end":    return (buf, _pos) => bufferEnd(buf);
    default:              return null;
  }
}
