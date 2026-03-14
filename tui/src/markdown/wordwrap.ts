import { formatMarkdown, stripMarkdown, termWidth, visibleLength, sliceByWidth } from "./formatting";
import { isCodeBlockLine, FENCE_OPEN_RE, isFenceClose, renderCodeBlock } from "./codeblocks";
import { isTableLine, isTableSeparator, isBoxDrawingLine, renderTableBlock } from "./tables";

const FG_DIM = "\x1b[38;2;100;100;100m";
const RESET = "\x1b[0m";

/**
 * Detects markdown horizontal rules (3+ of -, *, or _)
 */
export function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])([ \t]*\1){2,}\s*$/.test(line);
}

/**
 * Main markdown-aware word wrapping function.
 * 
 * Processes text line by line and:
 * 1. Detects fenced code blocks and renders them with syntax highlighting
 * 2. Detects table blocks and renders with box-drawing
 * 3. Detects horizontal rules and renders them as box-drawing lines
 * 4. For regular paragraph text, word-wraps to fit within width
 * 
 * @param text The markdown text to wrap
 * @param width The width to wrap to
 * @param bgRestore Controls markdown formatting:
 *   - When provided (non-null), means we're rendering an assistant message — apply formatMarkdown
 *   - When null/undefined, it's a user message — keep text plain
 * @returns Array of wrapped lines
 */
export function markdownWordWrap(text: string, width: number, bgRestore?: string): string[] {
  if (width < 1) return [text];

  const inputLines = text.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < inputLines.length) {
    // Detect fenced code blocks: ```language ... ```
    // Only for assistant messages (bgRestore is the markdown-mode signal)
    const fenceMatch = bgRestore != null ? inputLines[i].match(FENCE_OPEN_RE) : null;
    if (fenceMatch) {
      const fenceLen = fenceMatch[1].length;
      const language = fenceMatch[2] || "";
      const codeLines: string[] = [];
      i++; // skip opening fence
      while (i < inputLines.length && !isFenceClose(inputLines[i], fenceLen)) {
        codeLines.push(inputLines[i]);
        i++;
      }
      if (i < inputLines.length) i++; // skip closing fence
      result.push(...renderCodeBlock(codeLines, language, width));
      continue;
    }

    // Detect table blocks: consecutive lines matching markdown table syntax
    if (isTableLine(inputLines[i])) {
      const start = i;
      while (i < inputLines.length && isTableLine(inputLines[i])) {
        i++;
      }
      result.push(...renderTableBlock(inputLines.slice(start, i), width, bgRestore));
      continue;
    }

    // Detect horizontal rules
    if (bgRestore != null && isHorizontalRule(inputLines[i])) {
      // Render as a thin box-drawing line
      const hrChar = "─";
      const hrWidth = Math.min(width, 40); // cap at 40 chars
      result.push(FG_DIM + hrChar.repeat(hrWidth) + RESET);
      i++;
      continue;
    }

    // Regular paragraph text — word-wrap
    wrapParagraph(inputLines[i], width, result);
    i++;
  }

  return result;
}

/**
 * Helper: wraps a single paragraph to fit within width
 */
function wrapParagraph(paragraph: string, width: number, result: string[]): void {
  if (paragraph === "") {
    result.push("");
    return;
  }
  const words = paragraph.split(/\s+/);
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = visibleLength(word) > width ? hardBreak(word, width, result) : word;
    } else if (visibleLength(line) + 1 + visibleLength(word) <= width) {
      line += " " + word;
    } else {
      result.push(line);
      line = visibleLength(word) > width ? hardBreak(word, width, result) : word;
    }
  }
  if (line !== "") result.push(line);
}

/**
 * Helper: hard-break a word that is longer than the width
 */
function hardBreak(word: string, width: number, result: string[]): string {
  let remaining = word;
  for (;;) {
    const [taken, rest] = sliceByWidth(remaining, width);
    if (!rest) return taken;
    if (taken === "") {
      result.push(remaining.slice(0, 1));
      remaining = remaining.slice(1);
    } else {
      result.push(taken);
      remaining = rest;
    }
  }
}
