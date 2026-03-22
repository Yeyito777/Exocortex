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

/** Captures a slash command followed by any number of trailing words. */
const COMMAND_SPAN_RE = /(^|[ \t\n])(\/[\w-]+(?:[ \t]+[\w-]+)*)/gm;

/**
 * Find buffer ranges that contain valid command/macro tokens.
 * Each span covers the command name and as many recognized nested
 * arguments as possible (e.g. "/tool install discord" highlights fully).
 */
function findCommandSpans(buffer: string): Span[] {
  const spans: Span[] = [];
  COMMAND_SPAN_RE.lastIndex = 0;

  let match;
  while ((match = COMMAND_SPAN_RE.exec(buffer)) !== null) {
    const boundary = match[1];
    const full = match[2]; // e.g. "/tool install discord"
    const cmdStart = match.index + boundary.length;

    // Parse word positions within the captured group
    const wordRe = /[\w-]+/g;
    const wordPositions: { word: string; end: number }[] = [];
    let wm;
    while ((wm = wordRe.exec(full)) !== null) {
      wordPositions.push({ word: wm[0], end: wm.index + wm[0].length });
    }
    if (wordPositions.length === 0) continue;

    // First word (with /) must be a known command or macro
    const baseCmd = full.slice(0, wordPositions[0].end);
    if (!VALID_NAMES.has(baseCmd)) continue;
    let spanEnd = cmdStart + wordPositions[0].end;

    // Walk through subsequent words, extending highlight while args are valid
    let key = baseCmd;
    for (let i = 1; i < wordPositions.length; i++) {
      if (VALID_ARGS[key]?.has(wordPositions[i].word)) {
        spanEnd = cmdStart + wordPositions[i].end;
        key = key + " " + wordPositions[i].word;
      } else {
        break;
      }
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
