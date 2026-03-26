/**
 * Shared utilities for tool implementations.
 */

export const MAX_OUTPUT_CHARS = 30_000;

/**
 * Truncate a string without splitting UTF-16 surrogate pairs.
 *
 * JavaScript's `.slice()` operates on UTF-16 code units.  Characters outside
 * the Basic Multilingual Plane (most emoji) are stored as two code units —
 * a high surrogate (D800–DBFF) followed by a low surrogate (DC00–DFFF).
 * Slicing between them produces a lone surrogate which is invalid in JSON
 * and will cause Anthropic API 400 errors.
 */
export function safeSlice(str: string, end: number): string {
  if (str.length <= end) return str;
  const sliced = str.slice(0, end);
  // If the last char is a high surrogate, its low surrogate was cut off
  const lastCode = sliced.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    return sliced.slice(0, -1);
  }
  return sliced;
}

/** Truncate output to MAX_OUTPUT_CHARS with a message. */
export function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return safeSlice(text, MAX_OUTPUT_CHARS) +
    `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${text.length} characters)`;
}

// ── Input validation helpers ──────────────────────────────────────

/** Extract a string from tool input, returning undefined if missing or wrong type. */
export function getString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

/** Extract a number from tool input, returning undefined if missing or wrong type. */
export function getNumber(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}

/** Extract a boolean from tool input, returning undefined if missing or wrong type. */
export function getBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === "boolean" ? v : undefined;
}

// ── Summary helpers ─────────────────────────────────────────────────

/**
 * Build a summary detail string from a primary value plus all remaining
 * input params, excluding the given skip keys.
 *
 * - Booleans: `true` → `--key`, `false` → omitted
 * - Strings/numbers: `--key value`
 * - Keys already starting with `-` are used as-is (backwards compat)
 */
export function summarizeParams(
  primary: string,
  input: Record<string, unknown>,
  skip: string[],
): string {
  const parts = [primary];
  for (const [key, value] of Object.entries(input)) {
    if (skip.includes(key) || value == null) continue;
    const flag = key.startsWith("-") ? key : `--${key}`;
    if (typeof value === "boolean") {
      if (value) parts.push(flag);
    } else {
      parts.push(`${flag} ${value}`);
    }
  }
  return parts.join(" ");
}
