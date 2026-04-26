/** Utilities for terminal-safe display of untrusted conversation content. */

/**
 * Neutralize terminal control characters in untrusted message/tool text.
 *
 * Conversation content is rendered directly into the terminal, so raw CR,
 * ESC, tabs, and other control bytes can corrupt layout (for example curl's
 * carriage-return progress lines overwriting the sidebar). Keep newlines, but
 * turn other controls into safe display text before wrapping/rendering.
 */
export function sanitizeUntrustedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/\x1b/g, "␛")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "�");
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsiStyles(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function isVisuallyBlankLine(line: string): boolean {
  return stripAnsiStyles(line).trim().length === 0;
}
