/**
 * Vim text objects — pure functions.
 *
 * Each text object takes a buffer + cursor position and returns
 * a Range { start, end } where end is exclusive, or null if no
 * match is found. "inner" variants exclude delimiters, "a" variants
 * include them (and trailing/leading whitespace for word objects).
 *
 * Enclosed objects (quotes, brackets) forward-search on the current
 * line if the cursor is not inside a pair, matching vim behavior.
 */

import type { Range } from "./types";
import { lineStartOf, lineEndOf } from "./buffer";
import { isWordChar, isSpace as isWhitespace, isWORDChar } from "../chars";

// ── Word objects (iw, aw) ──────────────────────────────────────────

/** iw — inner word: the word under the cursor. */
export function innerWord(buf: string, cursor: number): Range | null {
  if (buf.length === 0) return null;
  const pos = Math.min(cursor, buf.length - 1);
  const ch = buf[pos];

  let start: number, end: number;

  if (isWordChar(ch)) {
    start = pos;
    while (start > 0 && isWordChar(buf[start - 1])) start--;
    end = pos;
    while (end < buf.length - 1 && isWordChar(buf[end + 1])) end++;
    return { start, end: end + 1 };
  }

  if (isWhitespace(ch)) {
    start = pos;
    while (start > 0 && isWhitespace(buf[start - 1])) start--;
    end = pos;
    while (end < buf.length - 1 && isWhitespace(buf[end + 1])) end++;
    return { start, end: end + 1 };
  }

  // Punctuation / symbols
  start = pos;
  while (start > 0 && !isWordChar(buf[start - 1]) && !isWhitespace(buf[start - 1]) && buf[start - 1] !== "\n") start--;
  end = pos;
  while (end < buf.length - 1 && !isWordChar(buf[end + 1]) && !isWhitespace(buf[end + 1]) && buf[end + 1] !== "\n") end++;
  return { start, end: end + 1 };
}

/** aw — a word: word + trailing whitespace (or leading if at end). */
export function aWord(buf: string, cursor: number): Range | null {
  const inner = innerWord(buf, cursor);
  if (!inner) return null;

  let { start, end } = inner;

  // Try to include trailing whitespace
  if (end < buf.length && isWhitespace(buf[end])) {
    while (end < buf.length && isWhitespace(buf[end])) end++;
    return { start, end };
  }

  // No trailing — include leading whitespace
  if (start > 0 && isWhitespace(buf[start - 1])) {
    while (start > 0 && isWhitespace(buf[start - 1])) start--;
    return { start, end };
  }

  return { start, end };
}

// ── WORD objects (iW, aW) ──────────────────────────────────────────

/** iW — inner WORD: contiguous non-whitespace. */
export function innerWORD(buf: string, cursor: number): Range | null {
  if (buf.length === 0) return null;
  const pos = Math.min(cursor, buf.length - 1);
  const ch = buf[pos];

  if (!isWORDChar(ch)) {
    // On whitespace — select whitespace run
    let start = pos;
    while (start > 0 && !isWORDChar(buf[start - 1])) start--;
    let end = pos;
    while (end < buf.length - 1 && !isWORDChar(buf[end + 1])) end++;
    return { start, end: end + 1 };
  }

  let start = pos;
  while (start > 0 && isWORDChar(buf[start - 1])) start--;
  let end = pos;
  while (end < buf.length - 1 && isWORDChar(buf[end + 1])) end++;
  return { start, end: end + 1 };
}

/** aW — a WORD: WORD + trailing whitespace (or leading if at end). */
export function aWORD(buf: string, cursor: number): Range | null {
  const inner = innerWORD(buf, cursor);
  if (!inner) return null;

  let { start, end } = inner;

  if (end < buf.length && isWhitespace(buf[end])) {
    while (end < buf.length && isWhitespace(buf[end])) end++;
    return { start, end };
  }

  if (start > 0 && isWhitespace(buf[start - 1])) {
    while (start > 0 && isWhitespace(buf[start - 1])) start--;
    return { start, end };
  }

  return { start, end };
}

// ── Quote objects (i", a", i', a', i`, a`) ────────────────────────

/**
 * Find the quote pair containing the cursor, or forward-search on
 * the same line. Vim counts quotes from line start to determine
 * which pair the cursor is in.
 */
function findQuotePair(buf: string, cursor: number, quote: string): { open: number; close: number } | null {
  const ls = lineStartOf(buf, cursor);
  const le = lineEndOf(buf, cursor);

  // Collect all quote positions on this line
  const positions: number[] = [];
  for (let i = ls; i < le; i++) {
    if (buf[i] === quote && (i === ls || buf[i - 1] !== "\\")) {
      positions.push(i);
    }
  }

  // Need at least 2 quotes to form a pair
  if (positions.length < 2) return null;

  // Find the pair that contains the cursor
  for (let i = 0; i < positions.length - 1; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (cursor >= open && cursor <= close) {
      return { open, close };
    }
  }

  // Not inside any pair — forward-search for next pair after cursor
  for (let i = 0; i < positions.length - 1; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (open > cursor) {
      return { open, close };
    }
  }

  return null;
}

/** i" / i' / i` — inner quote: content between quotes (exclusive). */
export function innerQuote(buf: string, cursor: number, quote: string): Range | null {
  const pair = findQuotePair(buf, cursor, quote);
  if (!pair) return null;
  return { start: pair.open + 1, end: pair.close };
}

/** a" / a' / a` — around quote: includes the quote characters. */
export function aQuote(buf: string, cursor: number, quote: string): Range | null {
  const pair = findQuotePair(buf, cursor, quote);
  if (!pair) return null;
  return { start: pair.open, end: pair.close + 1 };
}

// ── Pair/bracket objects ──────────────────────────────────────────

/**
 * Find the matching pair of brackets containing the cursor,
 * with proper nesting support. Forward-searches on the same line
 * if the cursor is not inside a pair.
 */
function findMatchingPair(buf: string, cursor: number, open: string, close: string): { openPos: number; closePos: number } | null {
  // First, try to find enclosing pair by scanning outward
  const result = findEnclosingPair(buf, cursor, open, close);
  if (result) return result;

  // Forward-search on the same line
  const le = lineEndOf(buf, cursor);
  for (let i = cursor + 1; i < le; i++) {
    if (buf[i] === open) {
      const closePos = findMatchingClose(buf, i, open, close);
      if (closePos !== null) return { openPos: i, closePos };
    }
  }

  return null;
}

/** Scan outward from cursor to find the enclosing open/close pair. */
function findEnclosingPair(buf: string, cursor: number, open: string, close: string): { openPos: number; closePos: number } | null {
  // If cursor is ON an open bracket, match forward
  if (buf[cursor] === open) {
    const closePos = findMatchingClose(buf, cursor, open, close);
    if (closePos !== null) return { openPos: cursor, closePos };
  }

  // If cursor is ON a close bracket, match backward
  if (buf[cursor] === close) {
    const openPos = findMatchingOpen(buf, cursor, open, close);
    if (openPos !== null) return { openPos, closePos: cursor };
  }

  // Scan backward for unmatched open bracket
  let depth = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    if (buf[i] === close) depth++;
    if (buf[i] === open) {
      if (depth === 0) {
        const closePos = findMatchingClose(buf, i, open, close);
        if (closePos !== null && closePos >= cursor) {
          return { openPos: i, closePos };
        }
      } else {
        depth--;
      }
    }
  }

  return null;
}

/** Find the matching close bracket, respecting nesting. */
function findMatchingClose(buf: string, openPos: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = openPos + 1; i < buf.length; i++) {
    if (buf[i] === open) depth++;
    if (buf[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

/** Find the matching open bracket, respecting nesting. */
function findMatchingOpen(buf: string, closePos: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = closePos - 1; i >= 0; i--) {
    if (buf[i] === close) depth++;
    if (buf[i] === open) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

/** i( / i{ / i[ / i< — inner pair: content between brackets (exclusive). */
export function innerPair(buf: string, cursor: number, open: string, close: string): Range | null {
  const pair = findMatchingPair(buf, cursor, open, close);
  if (!pair) return null;
  return { start: pair.openPos + 1, end: pair.closePos };
}

/** a( / a{ / a[ / a< — around pair: includes the brackets. */
export function aPair(buf: string, cursor: number, open: string, close: string): Range | null {
  const pair = findMatchingPair(buf, cursor, open, close);
  if (!pair) return null;
  return { start: pair.openPos, end: pair.closePos + 1 };
}

// ── Text object registry ──────────────────────────────────────────

/** Resolve a text object specifier key to a Range. */
export function resolveTextObject(
  modifier: "i" | "a",
  key: string,
  buf: string,
  cursor: number,
): Range | null {
  switch (key) {
    // Word objects
    case "w": return modifier === "i" ? innerWord(buf, cursor) : aWord(buf, cursor);
    case "W": return modifier === "i" ? innerWORD(buf, cursor) : aWORD(buf, cursor);

    // Quote objects
    case '"': return modifier === "i" ? innerQuote(buf, cursor, '"') : aQuote(buf, cursor, '"');
    case "'": return modifier === "i" ? innerQuote(buf, cursor, "'") : aQuote(buf, cursor, "'");
    case "`": return modifier === "i" ? innerQuote(buf, cursor, "`") : aQuote(buf, cursor, "`");

    // Bracket objects
    case "(": case ")": case "b":
      return modifier === "i" ? innerPair(buf, cursor, "(", ")") : aPair(buf, cursor, "(", ")");
    case "{": case "}": case "B":
      return modifier === "i" ? innerPair(buf, cursor, "{", "}") : aPair(buf, cursor, "{", "}");
    case "[": case "]":
      return modifier === "i" ? innerPair(buf, cursor, "[", "]") : aPair(buf, cursor, "[", "]");
    case "<": case ">":
      return modifier === "i" ? innerPair(buf, cursor, "<", ">") : aPair(buf, cursor, "<", ">");

    default:
      return null;
  }
}

/** Check if a key is a valid text object specifier. */
export function isTextObjectKey(key: string): boolean {
  return /^[wW"'`(){}\[\]<>bB]$/.test(key);
}
