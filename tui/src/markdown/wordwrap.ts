import { theme } from "../theme";
import { formatMarkdown, stripMarkdown, termWidth, hardBreak, isHorizontalRule } from "./formatting";
import { FENCE_OPEN_RE, isFenceClose, renderCodeBlock } from "./codeblocks";
import { isTableLine, renderTableBlock } from "./tables";

export interface MarkdownWrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
}

function pushStandaloneLines(result: string[], cont: boolean[], lines: string[]): void {
  result.push(...lines);
  cont.push(...lines.map(() => false));
}

/**
 * Main markdown-aware word wrapping function.
 *
 * Processes text line by line and:
 * 1. Detects fenced code blocks and renders them with syntax highlighting
 * 2. Detects table blocks and renders with box-drawing
 * 3. Detects horizontal rules and renders them as box-drawing lines
 * 4. For regular paragraph text, word-wraps to fit within width and
 *    applies inline markdown formatting (bold/italic/code)
 *
 * Output lines are fully formatted — the caller only needs to indent them.
 *
 * @param text The markdown text to wrap
 * @param width The width to wrap to
 * @param bgRestore Controls markdown formatting:
 *   - When provided (non-null), means we're rendering an assistant message — apply formatMarkdown
 *   - When null/undefined, it's a user message — keep text plain
 * @returns Wrapped, formatted lines plus continuation flags
 */
export function markdownWordWrap(text: string, width: number, bgRestore?: string): MarkdownWrapResult {
  if (width < 1) return { lines: [text], cont: [false] };

  const inputLines = text.split("\n");
  const result: string[] = [];
  const cont: boolean[] = [];

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
      const rendered = renderCodeBlock(codeLines, language, width);
      pushStandaloneLines(result, cont, rendered);
      continue;
    }

    // Detect table blocks: consecutive lines matching markdown table syntax
    if (isTableLine(inputLines[i])) {
      const start = i;
      while (i < inputLines.length && isTableLine(inputLines[i])) {
        i++;
      }
      const rendered = renderTableBlock(inputLines.slice(start, i), width, bgRestore);
      pushStandaloneLines(result, cont, rendered);
      continue;
    }

    // Detect horizontal rules
    if (bgRestore != null && isHorizontalRule(inputLines[i])) {
      // Render as a thin box-drawing line
      const hrWidth = Math.min(width, 40); // cap at 40 chars
      result.push(theme.muted + "─".repeat(hrWidth) + theme.reset);
      cont.push(false);
      i++;
      continue;
    }

    // Regular paragraph text — word-wrap and optionally format
    wrapParagraph(inputLines[i], width, result, cont, bgRestore);
    i++;
  }

  return { lines: result, cont };
}

/**
 * Wraps a single paragraph to fit within width.
 *
 * When bgRestore is provided (assistant mode), width measurement accounts
 * for markdown markers (** etc.) being invisible after formatting, and
 * formatMarkdown is applied to each wrapped line.
 */
function wrapParagraph(
  paragraph: string,
  width: number,
  result: string[],
  cont: boolean[],
  bgRestore?: string,
): void {
  if (paragraph === "") {
    result.push("");
    cont.push(false);
    return;
  }

  // In markdown mode, measure visible width excluding markers.
  // In plain mode, measure raw terminal width.
  const measure = bgRestore != null
    ? (s: string) => termWidth(stripMarkdown(s))
    : termWidth;

  // First pass: word-wrap with correct measurement
  const wrapped: string[] = [];
  const words = paragraph.split(/\s+/);
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = measure(word) > width ? hardBreak(word, width, wrapped) : word;
    } else if (measure(line) + 1 + measure(word) <= width) {
      line += " " + word;
    } else {
      wrapped.push(line);
      line = measure(word) > width ? hardBreak(word, width, wrapped) : word;
    }
  }
  if (line !== "") wrapped.push(line);

  // Second pass: apply inline markdown formatting if in assistant mode
  if (bgRestore) {
    for (let i = 0; i < wrapped.length; i++) {
      result.push(formatMarkdown(wrapped[i], bgRestore).text);
      cont.push(i > 0);
    }
  } else {
    for (let i = 0; i < wrapped.length; i++) {
      result.push(wrapped[i]);
      cont.push(i > 0);
    }
  }
}
