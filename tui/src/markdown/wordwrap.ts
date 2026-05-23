import { theme } from "../theme";
import { formatMarkdownChunks, stripMarkdown, termWidth, sliceByWidth, isHorizontalRule } from "./formatting";
import { FENCE_OPEN_RE, isFenceClose, renderCodeBlockWrapped, stripFenceIndent } from "./codeblocks";
import { isTableLine, renderTableBlock } from "./tables";
import type { WrapCopyLine } from "../textwrap";

export interface MarkdownWrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing plain text. */
  join: string[];
  /** Optional per-row plain source projection for vim yanks/copies. */
  copy?: Array<WrapCopyLine | null>;
}

function pushStandaloneLines(result: string[], cont: boolean[], join: string[], copy: Array<WrapCopyLine | null>, lines: string[]): void {
  result.push(...lines);
  cont.push(...lines.map(() => false));
  join.push(...lines.map(() => ""));
  copy.push(...lines.map(() => null));
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
  const copy: Array<WrapCopyLine | null> = [];

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
      const rendered = renderCodeBlockWrapped(codeLines, language, width);
      result.push(...rendered.lines);
      cont.push(...rendered.cont);
      join.push(...rendered.join);
      copy.push(...rendered.copy);
      continue;
    }

    // Detect table blocks: consecutive lines matching markdown table syntax
    if (isTableLine(inputLines[i])) {
      const start = i;
      while (i < inputLines.length && isTableLine(inputLines[i])) {
        i++;
      }
      const rendered = renderTableBlock(inputLines.slice(start, i), width, bgRestore);
      pushStandaloneLines(result, cont, join, copy, rendered);
      continue;
    }

    // Detect horizontal rules
    if (bgRestore != null && isHorizontalRule(inputLines[i])) {
      // Render as a thin box-drawing line
      const hrWidth = Math.min(width, 40); // cap at 40 chars
      result.push(theme.muted + "─".repeat(hrWidth) + theme.reset);
      cont.push(false);
      join.push("");
      copy.push(null);
      i++;
      continue;
    }

    // Regular paragraph text.  Collect consecutive non-special physical lines
    // so inline markdown can span hard newlines while preserving those line
    // breaks in the rendered output.
    const paragraphLines: string[] = [];
    while (i < inputLines.length) {
      const line = inputLines[i];
      if (line === "") break;
      if (bgRestore != null && line.match(FENCE_OPEN_RE)) break;
      if (isTableLine(line)) break;
      if (bgRestore != null && isHorizontalRule(line)) break;
      paragraphLines.push(line);
      i++;
    }

    if (paragraphLines.length > 0) {
      wrapParagraphBlock(paragraphLines, width, result, cont, join, copy, bgRestore);
      continue;
    }

    wrapParagraphBlock([inputLines[i]], width, result, cont, join, copy, bgRestore);
    i++;
  }

  return { lines: result, cont, join, copy };
}

interface RawWrapResult {
  lines: string[];
  join: string[];
}

/**
 * Wraps one physical paragraph line to fit within width, but leaves markdown
 * markers in place. Formatting is applied later across all related visual
 * chunks so spans can cross soft wraps and hard newlines.
 */
function wrapParagraphRaw(paragraph: string, width: number, bgRestore?: string): RawWrapResult {
  if (paragraph === "") return { lines: [""], join: [""] };

  // In markdown mode, measure visible width excluding markers.
  // In plain mode, measure raw terminal width.
  const hasInlineMarkdown = bgRestore != null && /[*`]/.test(paragraph);
  const measure = hasInlineMarkdown
    ? (s: string) => termWidth(stripMarkdown(s))
    : termWidth;

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

  return { lines: wrapped, join: wrappedJoin };
}

function wrapParagraphBlock(
  paragraphs: string[],
  width: number,
  result: string[],
  cont: boolean[],
  join: string[],
  copy: Array<WrapCopyLine | null>,
  bgRestore?: string,
): void {
  const rawLines: string[] = [];
  const parseJoin: string[] = [];
  const outCont: boolean[] = [];
  const outJoin: string[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const wrapped = wrapParagraphRaw(paragraphs[p], width, bgRestore);
    for (let i = 0; i < wrapped.lines.length; i++) {
      rawLines.push(wrapped.lines[i]);
      parseJoin.push(i === 0 ? (rawLines.length === 1 ? "" : "\n") : wrapped.join[i]);
      outCont.push(i > 0);
      outJoin.push(i > 0 ? wrapped.join[i] : "");
    }
  }

  const shouldFormatMarkdown = bgRestore != null && paragraphs.some(paragraph => /[*`]/.test(paragraph));
  const rendered = shouldFormatMarkdown
    ? formatMarkdownChunks(rawLines, parseJoin, bgRestore)
    : rawLines;

  result.push(...rendered);
  cont.push(...outCont);
  join.push(...outJoin);
  copy.push(...rendered.map(() => null));
}
