import { highlightLine, isLanguageSupported } from "./highlight";
import { termWidth, sliceByWidth } from "./formatting";

// ANSI color codes
const FG_WHITE = "\x1b[38;2;255;255;255m";
const FG_SYN_GUTTER = "\x1b[38;2;55;65;80m";   // #374150 gutter char color
const FG_SYN_LABEL = "\x1b[38;2;80;90;105m";    // #505a69 dim label for language name

// Gutter character constant
export const CODE_GUTTER = "▎";

// Regex for detecting opening fence line
export const FENCE_OPEN_RE = /^ {0,3}(`{3,})(\w*)\s*$/;

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
 * Detects closing fence (at least as many backticks as opening)
 */
export function isFenceClose(line: string, fenceLen: number): boolean {
  const m = line.match(/^ {0,3}(`{3,})\s*$/);
  return m != null && m[1].length >= fenceLen;
}

/**
 * Renders code block lines with syntax highlighting and gutter
 */
export function renderCodeBlock(
  codeLines: string[],
  language: string,
  maxWidth: number
): string[] {
  const result: string[] = [];
  const hasLang = language && isLanguageSupported(language);
  const displayLang = language || "";
  const gutterPrefix = FG_SYN_GUTTER + CODE_GUTTER + " ";
  const codeWidth = Math.max(1, maxWidth - 2);

  // Language label line (if language specified)
  if (displayLang) {
    result.push(gutterPrefix + FG_SYN_LABEL + displayLang);
  }

  // Code content lines
  for (const line of codeLines) {
    if (line === "") {
      result.push(gutterPrefix);
      continue;
    }

    const chunks = hardBreakCode(line, codeWidth);
    for (const chunk of chunks) {
      if (hasLang) {
        result.push(gutterPrefix + highlightLine(chunk, language));
      } else {
        result.push(gutterPrefix + FG_WHITE + chunk);
      }
    }
  }

  return result;
}

/**
 * Breaks a code line into chunks that fit within the given width
 */
function hardBreakCode(line: string, width: number): string[] {
  if (termWidth(line) <= width) {
    return [line];
  }

  const result: string[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    const [taken, rest] = sliceByWidth(remaining, width);

    if (taken === "") {
      // Single character wider than width — force take first character
      result.push(remaining.slice(0, 1));
      remaining = remaining.slice(1);
    } else {
      result.push(taken);
      remaining = rest;
    }
  }

  return result;
}
