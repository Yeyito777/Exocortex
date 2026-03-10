/**
 * Prompt line syntax highlighting for commands and macros.
 *
 * Highlights valid slash commands and macros (and their recognized
 * arguments) with a distinctive color in the prompt input area.
 * ANSI-aware: output composes correctly with visual selection
 * highlighting applied afterward.
 */

import { COMMAND_LIST, COMMAND_ARGS } from "./commands";
import { MACRO_LIST, MACRO_ARGS } from "./macros";
import { theme } from "./theme";
import { wrappedLineOffsets } from "./promptline";

// ── Valid names & args ────────────────────────────────────────────

const VALID_NAMES = new Set([
  ...COMMAND_LIST.map(c => c.name),
  ...MACRO_LIST.map(c => c.name),
  "/exit",  // alias not in COMMAND_LIST (filtered out for display)
]);

/** Map of command/macro name → set of valid argument names. */
const VALID_ARGS: Record<string, Set<string>> = {
  ...Object.fromEntries(
    Object.entries(COMMAND_ARGS).map(([cmd, args]) => [cmd, new Set(args.map(a => a.name))]),
  ),
  ...Object.fromEntries(
    Object.entries(MACRO_ARGS).map(([cmd, args]) => [cmd, new Set(args.map(a => a.name))]),
  ),
};

// ── Span detection ───────────────────────────────────────────────

interface Span { start: number; end: number }

const COMMAND_SPAN_RE = /(^|[ \t\n])(\/[\w-]+)(?:[ \t]+([\w-]+))?/gm;

/**
 * Find buffer ranges that contain valid command/macro tokens.
 * Each span covers the command name and, if present, a recognized argument.
 */
function findCommandSpans(buffer: string): Span[] {
  const spans: Span[] = [];
  COMMAND_SPAN_RE.lastIndex = 0;

  let match;
  while ((match = COMMAND_SPAN_RE.exec(buffer)) !== null) {
    const boundary = match[1];
    const cmd = match[2];
    const arg = match[3];

    if (!VALID_NAMES.has(cmd)) continue;

    const cmdStart = match.index + boundary.length;
    let spanEnd: number;

    if (arg && VALID_ARGS[cmd]?.has(arg)) {
      // Highlight command + space(s) + arg
      spanEnd = match.index + match[0].length;
    } else {
      // Highlight command name only
      spanEnd = cmdStart + cmd.length;
    }

    spans.push({ start: cmdStart, end: spanEnd });
  }

  return spans;
}

// ── Line highlighting ────────────────────────────────────────────

/**
 * Apply command/macro highlighting to wrapped prompt input lines.
 *
 * Takes the visible lines from getInputLines (which may be a scrolled
 * window into the full set of wrapped lines), the original buffer,
 * the wrapping width, and the scroll offset so we can map each
 * visible line back to its buffer position.
 */
export function highlightPromptInput(
  lines: string[],
  buffer: string,
  maxWidth: number,
  scrollOffset: number,
): string[] {
  const spans = findCommandSpans(buffer);
  if (spans.length === 0) return lines;

  const offsets = wrappedLineOffsets(buffer, maxWidth);

  return lines.map((line, i) => {
    const wrappedIdx = scrollOffset + i;
    if (wrappedIdx >= offsets.length) return line;

    const lineStart = offsets[wrappedIdx];
    const lineEnd = lineStart + line.length;

    // Collect overlapping highlight regions (in visible column space)
    const regions: { col: number; len: number }[] = [];
    for (const span of spans) {
      if (span.end <= lineStart || span.start >= lineEnd) continue;
      const colStart = Math.max(0, span.start - lineStart);
      const colEnd = Math.min(line.length, span.end - lineStart);
      regions.push({ col: colStart, len: colEnd - colStart });
    }

    if (regions.length === 0) return line;

    // Build the line with ANSI color applied to highlighted regions
    let result = "";
    let pos = 0;
    for (const { col, len } of regions) {
      if (col > pos) result += line.slice(pos, col);
      result += theme.command + line.slice(col, col + len) + theme.reset;
      pos = col + len;
    }
    if (pos < line.length) result += line.slice(pos);

    return result;
  });
}
