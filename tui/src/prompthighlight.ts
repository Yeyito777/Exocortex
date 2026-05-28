/**
 * Prompt line syntax highlighting for commands and macros.
 *
 * Highlights valid slash commands and macros (and their recognized
 * arguments) with a distinctive color in the prompt input area.
 * ANSI-aware: output composes correctly with visual selection
 * highlighting applied afterward.
 */

import type { RenderState } from "./state";
import { COMMAND_LIST, getCommandArgs } from "./commands";
import { MACRO_LIST, getMacroArgs } from "./macros";
import { INLINE_EFFORT_COMMAND, getInlineEffortArgs } from "./inlineeffort";
import { theme } from "./theme";
import { wrappedLineOffsets } from "./promptline";

// ── Valid names & args ────────────────────────────────────────────

const VALID_COMMAND_NAMES = new Set([
  ...COMMAND_LIST.map(c => c.name),
  "/exit",  // alias not in COMMAND_LIST (filtered out for display)
]);

const VALID_MACRO_NAMES = new Set(MACRO_LIST.map(c => c.name));

const VALID_INLINE_COMMAND_NAMES = new Set([INLINE_EFFORT_COMMAND.name]);

function buildValidArgs(state: RenderState): Record<string, Set<string>> {
  return {
    ...Object.fromEntries(
      Object.entries(getCommandArgs(state)).map(([cmd, args]) => [cmd, new Set(args.map(arg => arg.name))]),
    ),
    ...Object.fromEntries(
      Object.entries(getInlineEffortArgs(state)).map(([cmd, args]) => [cmd, new Set(args.map(arg => arg.name))]),
    ),
    ...Object.fromEntries(
      Object.entries(getMacroArgs()).map(([cmd, args]) => [cmd, new Set(args.map(arg => arg.name))]),
    ),
  };
}

function customModelProviders(state: RenderState): Set<string> {
  return new Set(
    state.providerRegistry
      .filter((provider) => provider.allowsCustomModels)
      .map((provider) => provider.id),
  );
}

// ── Span detection ───────────────────────────────────────────────

interface Span { start: number; end: number }

interface WordPosition { word: string; start: number; end: number }

/**
 * Find buffer ranges that contain valid command/macro tokens.
 * Each span covers the command name and as many recognized nested
 * arguments as possible (e.g. "/tool install discord" highlights fully).
 */
function findCommandSpans(
  buffer: string,
  validArgs: Record<string, Set<string>>,
  providersWithCustomModels: Set<string>,
): Span[] {
  const spans: Span[] = [];
  const words: WordPosition[] = [];
  const wordRe = /\S+/g;
  let match;
  while ((match = wordRe.exec(buffer)) !== null) {
    words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const firstWord = words[wordIndex];
    if (!firstWord.word.startsWith("/")) continue;

    // Commands are only commands at the start of a prompt.  Macros can appear
    // anywhere, and /effort is the single command allowed to behave like one.
    const baseCmd = firstWord.word;
    const isPromptCommand = wordIndex === 0 && VALID_COMMAND_NAMES.has(baseCmd);
    const isInlineSlash = VALID_MACRO_NAMES.has(baseCmd) || VALID_INLINE_COMMAND_NAMES.has(baseCmd);
    if (!isPromptCommand && !isInlineSlash) continue;
    let spanEnd = firstWord.end;

    // Walk through subsequent words, extending highlight while args are valid
    let key = baseCmd;
    for (let i = wordIndex + 1; i < words.length; i++) {
      if (validArgs[key]?.has(words[i].word)) {
        spanEnd = words[i].end;
        key = key + " " + words[i].word;
      } else if (key.startsWith("/model ") && providersWithCustomModels.has(key.slice("/model ".length))) {
        spanEnd = words[i].end;
        break;
      } else {
        break;
      }
    }

    spans.push({ start: firstWord.start, end: spanEnd });
  }

  return spans;
}

export function getPromptHighlightRanges(state: RenderState, buffer: string): Span[] {
  return findCommandSpans(buffer, buildValidArgs(state), customModelProviders(state));
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
  state: RenderState,
  lines: string[],
  buffer: string,
  maxWidth: number,
  scrollOffset: number,
): string[] {
  const spans = getPromptHighlightRanges(state, buffer);
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
