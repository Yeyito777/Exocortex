import { theme } from "../theme";
import { formatMarkdown, stripMarkdown, termWidth, sliceByWidth, isHorizontalRule } from "./formatting";
import { FENCE_OPEN_RE, isFenceClose, renderCodeBlock, stripFenceIndent } from "./codeblocks";
import { isTableLine, renderTableBlock } from "./tables";

export interface MarkdownWrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing plain text. */
  join: string[];
}

function pushStandaloneLines(result: string[], cont: boolean[], join: string[], lines: string[]): void {
  result.push(...lines);
  cont.push(...lines.map(() => false));
  join.push(...lines.map(() => ""));
}

function takeChunkByWidth(text: string, width: number): [string, string] {
  const [taken, rest] = sliceByWidth(text, width);
  if (taken !== "") return [taken, rest];
  return [text.slice(0, 1), text.slice(1)];
}

function seedLongWord(
  word: string,
  width: number,
  firstJoin: string,
): { pushedLines: string[]; pushedJoins: string[]; line: string; lineJoin: string } {
  const pushedLines: string[] = [];
  const pushedJoins: string[] = [];
  let remaining = word;
  let joinBefore = firstJoin;

  for (;;) {
    const [taken, rest] = takeChunkByWidth(remaining, width);
    if (!rest) {
      return { pushedLines, pushedJoins, line: taken, lineJoin: joinBefore };
    }
    pushedLines.push(taken);
    pushedJoins.push(joinBefore);
    remaining = rest;
    joinBefore = "";
  }
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
  if (width < 1) return { lines: [text], cont: [false], join: [""] };

  const inputLines = text.split("\n");
  const result: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  let i = 0;
  while (i < inputLines.length) {
    // Detect fenced code blocks: ```language ... ```
    // Only for assistant messages (bgRestore is the markdown-mode signal)
    const fenceMatch = bgRestore != null ? inputLines[i].match(FENCE_OPEN_RE) : null;
    if (fenceMatch) {
      const openingIndent = fenceMatch[1] || "";
      const fenceLen = fenceMatch[2].length;
      const language = (fenceMatch[3] || "").trim().split(/\s+/, 1)[0] || "";
      const codeLines: string[] = [];
      i++; // skip opening fence
      while (i < inputLines.length && !isFenceClose(inputLines[i], fenceLen)) {
        codeLines.push(stripFenceIndent(inputLines[i], openingIndent));
        i++;
      }
      if (i < inputLines.length) i++; // skip closing fence
      const rendered = renderCodeBlock(codeLines, language, width);
      pushStandaloneLines(result, cont, join, rendered);
      continue;
    }

    // Detect table blocks: consecutive lines matching markdown table syntax
    if (isTableLine(inputLines[i])) {
      const start = i;
      while (i < inputLines.length && isTableLine(inputLines[i])) {
        i++;
      }
      const rendered = renderTableBlock(inputLines.slice(start, i), width, bgRestore);
      pushStandaloneLines(result, cont, join, rendered);
      continue;
    }

    // Detect horizontal rules
    if (bgRestore != null && isHorizontalRule(inputLines[i])) {
      // Render as a thin box-drawing line
      const hrWidth = Math.min(width, 40); // cap at 40 chars
      result.push(theme.muted + "─".repeat(hrWidth) + theme.reset);
      cont.push(false);
      join.push("");
      i++;
      continue;
    }

    // Regular paragraph text — word-wrap and optionally format
    wrapParagraph(inputLines[i], width, result, cont, join, bgRestore);
    i++;
  }

  return { lines: result, cont, join };
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
  join: string[],
  bgRestore?: string,
): void {
  if (paragraph === "") {
    result.push("");
    cont.push(false);
    join.push("");
    return;
  }

  // In markdown mode, measure visible width excluding markers.
  // In plain mode, measure raw terminal width.
  const measure = bgRestore != null
    ? (s: string) => termWidth(stripMarkdown(s))
    : termWidth;

  // First pass: word-wrap with correct measurement and track whether wrapped
  // continuation rows should reinsert a space when copied back to plain text.
  const wrapped: string[] = [];
  const wrappedJoin: string[] = [];
  const words = paragraph.split(/\s+/);
  let line = "";
  let lineJoin = "";

  const startLineWithWord = (word: string, firstJoin: string) => {
    if (measure(word) <= width) {
      line = word;
      lineJoin = firstJoin;
      return;
    }
    const seeded = seedLongWord(word, width, firstJoin);
    wrapped.push(...seeded.pushedLines);
    wrappedJoin.push(...seeded.pushedJoins);
    line = seeded.line;
    lineJoin = seeded.lineJoin;
  };

  for (const word of words) {
    if (line === "") {
      startLineWithWord(word, wrapped.length > 0 ? " " : "");
    } else if (measure(line) + 1 + measure(word) <= width) {
      line += " " + word;
    } else {
      wrapped.push(line);
      wrappedJoin.push(lineJoin);
      startLineWithWord(word, " ");
    }
  }
  if (line !== "") {
    wrapped.push(line);
    wrappedJoin.push(lineJoin);
  }

  // Second pass: apply inline markdown formatting if in assistant mode
  if (bgRestore) {
    for (let i = 0; i < wrapped.length; i++) {
      result.push(formatMarkdown(wrapped[i], bgRestore).text);
      cont.push(i > 0);
      join.push(wrappedJoin[i]);
    }
  } else {
    for (let i = 0; i < wrapped.length; i++) {
      result.push(wrapped[i]);
      cont.push(i > 0);
      join.push(wrappedJoin[i]);
    }
  }
}
