/**
 * Character classification — shared across vim and history modules.
 *
 * Two space variants:
 * - isSpace: inline whitespace only (space, tab). Used by line-level
 *   operations (history motions, text objects) where \n never appears.
 * - isBufferSpace: includes \n. Used by buffer-level motions where
 *   the cursor traverses across line boundaries.
 */

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_]/u;

/** Word character: letters, digits and combining marks in any script, underscore. */
export function isWordChar(ch: string): boolean {
  return WORD_CHAR_RE.test(ch);
}

/** Inline whitespace (space or tab). For line-level operations. */
export function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/** Buffer whitespace (space, tab, or newline). For buffer-level motions. */
export function isBufferSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

/** Punctuation: not a word char, not buffer whitespace. */
export function isPunct(ch: string): boolean {
  return !isWordChar(ch) && !isBufferSpace(ch);
}

/** WORD character: anything that isn't inline whitespace or newline. */
export function isWORDChar(ch: string): boolean {
  return ch !== " " && ch !== "\t" && ch !== "\n";
}
