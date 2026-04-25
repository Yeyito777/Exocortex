import { highlightLine, isLanguageSupported, FG_WHITE } from "./highlight";
import { termWidth, hardBreak } from "./formatting";

export interface CodeBlockRenderResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous code line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing text. */
  join: string[];
}

// ANSI color codes (syntax-highlight-specific, not in theme)
const FG_SYN_GUTTER = "\x1b[38;2;55;65;80m";   // #374150 gutter char color
const FG_SYN_LABEL = "\x1b[38;2;80;90;105m";    // #505a69 dim label for language name

// Gutter character constant
export const CODE_GUTTER = "▎";

// Regex for detecting opening fence lines.
//
// This intentionally accepts arbitrary leading indentation instead of only the
// CommonMark top-level 0–3 spaces. Assistant replies often put fenced blocks
// inside list items, e.g. `   - label:` followed by `     ```bash`; because
// this renderer does not implement full list-container parsing, accepting and
// later stripping that container indent is the pragmatic markdown-compatible
// behavior users expect in the TUI.
export const FENCE_OPEN_RE = /^([ \t]*)(`{3,})[ \t]*([^`]*)[ \t]*$/;

/**
 * Detects if a line was produced by renderCodeBlock
 * (starts with ▎ after stripping ANSI codes)
 */
export function isCodeBlockLine(line: string): boolean {
  if (!line) return false;
  // Strip ANSI codes and check if starts with gutter character
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  return stripped.startsWith(CODE_GUTTER);
}

/**
 * Detects closing fence (at least as many backticks as opening).
 *
 * Like FENCE_OPEN_RE, this accepts arbitrary leading indentation so fenced
 * blocks nested inside list items close correctly without a full markdown block
 * parser.
 */
export function isFenceClose(line: string, fenceLen: number): boolean {
  const m = line.match(/^[ \t]*(`{3,})[ \t]*$/);
  return m != null && m[1].length >= fenceLen;
}

/**
 * Strips up to the opening fence's indentation from a code content line.
 * This mirrors the effect of list-container indentation for the simple fenced
 * blocks the TUI supports.
 */
export function stripFenceIndent(line: string, openingIndent: string): string {
  let i = 0;
  while (i < openingIndent.length && i < line.length && line[i] === openingIndent[i]) {
    i++;
  }
  return line.slice(i);
}

/**
 * Renders code block lines with syntax highlighting, gutter, and wrap metadata.
 */
export function renderCodeBlockWrapped(
  codeLines: string[],
  language: string,
  maxWidth: number
): CodeBlockRenderResult {
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const hasLang = language && isLanguageSupported(language);
  const displayLang = language || "";
  const gutterPrefix = FG_SYN_GUTTER + CODE_GUTTER + " ";
  const codeWidth = Math.max(1, maxWidth - 2);

  const push = (line: string, isContinuation: boolean) => {
    lines.push(line);
    cont.push(isContinuation);
    join.push("");
  };

  // Language label line (if language specified)
  if (displayLang) {
    push(gutterPrefix + FG_SYN_LABEL + displayLang, false);
  }

  // Code content lines
  for (const line of codeLines) {
    if (line === "") {
      push(gutterPrefix, false);
      continue;
    }

    const chunks = breakCodeLine(line, codeWidth);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const rendered = hasLang
        ? gutterPrefix + highlightLine(chunk, language)
        : gutterPrefix + FG_WHITE + chunk;
      push(rendered, i > 0);
    }
  }

  return { lines, cont, join };
}

/**
 * Renders code block lines with syntax highlighting and gutter.
 */
export function renderCodeBlock(
  codeLines: string[],
  language: string,
  maxWidth: number
): string[] {
  return renderCodeBlockWrapped(codeLines, language, maxWidth).lines;
}

/**
 * Breaks a code line into chunks that fit within the given width.
 * Uses the shared hardBreak for the actual splitting.
 */
function breakCodeLine(line: string, width: number): string[] {
  if (termWidth(line) <= width) return [line];
  const result: string[] = [];
  const tail = hardBreak(line, width, result);
  if (tail) result.push(tail);
  return result;
}
