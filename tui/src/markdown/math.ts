import type { WrapCopyLine } from "../textwrap";
import { termWidth } from "../textwidth";
import { FENCE_OPEN_RE, isFenceClose } from "./codeblocks";
import { stripMarkdown } from "./formatting";
import { layoutDisplay, layoutInline } from "./mathlayout";
import { BARE_MATH_ENVIRONMENTS, parseMath } from "./mathparse";

/**
 * Terminal math rendering.
 *
 * Delimited TeX in assistant Markdown is found once per message
 * (findMathFragments), parsed with a forgiving TeX parser (mathparse.ts) and
 * laid out as Unicode text (mathlayout.ts): inline math on one line, display
 * math as its own indented block with stacked fractions and aligned
 * environments where the terminal is wide enough. Copies of rendered math
 * yield the original TeX source.
 */

const MAX_TEX_LENGTH = 20_000;

/** Render TeX source (without delimiters) as terminal text. */
export function convertLatexMath(source: string, display = false): string {
  if (!source.trim()) return "";
  if (source.length > MAX_TEX_LENGTH) return source.trim();
  try {
    const nodes = parseMath(source);
    return display ? layoutDisplay(nodes).rows.join("\n") : layoutInline(nodes);
  } catch {
    // Rendering is presentation-only: never let malformed TeX hide a message.
    return source.trim();
  }
}

function inlineMath(source: string, nbsp: boolean): string {
  if (!source.trim()) return "";
  if (source.length > MAX_TEX_LENGTH) return source.trim();
  try {
    return layoutInline(parseMath(source), nbsp);
  } catch {
    return source.trim();
  }
}

function displayRows(source: string, width: number): { rows: string[]; lastBase: number } {
  const plain = { rows: [source.trim()], lastBase: 0 };
  if (!source.trim()) return { rows: [], lastBase: 0 };
  if (source.length > MAX_TEX_LENGTH) return plain;
  try {
    return layoutDisplay(parseMath(source), width);
  } catch {
    return plain;
  }
}

// ── Fragment detection ─────────────────────────────────────────────────

export type MathDelimiter = "$" | "$$" | "\\(" | "\\[" | "env";

/** One delimited TeX expression in a Markdown text. */
export interface MathFragment {
  /**
   * TeX between the delimiters (for "env", the whole `\begin…\end`). Lines
   * inside a blockquote have their `>` markers removed.
   */
  tex: string;
  /** Display math: `$$…$$`, `\[…\]`, or a bare math environment. */
  display: boolean;
  delimiter: MathDelimiter;
  /** Offset of the opening delimiter in the scanned text. */
  start: number;
  /** Offset just past the closing delimiter; `text.slice(start, end)` is the source. */
  end: number;
}

interface MathScan {
  fragments: MathFragment[];
  /** Offsets of the backslash in `\$` escapes outside code and math. */
  escapedDollars: number[];
}

const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]?)+/;

function isEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && input[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function countRun(input: string, from: number, char: string): number {
  let i = from;
  while (input[i] === char) i++;
  return i - from;
}

/** Fenced code block ranges [start, end) by character offset. */
function fencedRanges(text: string): Array<[number, number]> {
  if (!text.includes("```")) return [];
  const ranges: Array<[number, number]> = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(FENCE_OPEN_RE);
    if (!match) {
      offset += lines[index].length + 1;
      continue;
    }
    const start = offset;
    const fenceLength = match[2].length;
    offset += lines[index].length + 1;
    index++;
    while (index < lines.length && !isFenceClose(lines[index], fenceLength)) {
      offset += lines[index].length + 1;
      index++;
    }
    if (index < lines.length) offset += lines[index].length + 1;
    ranges.push([start, Math.min(offset, text.length)]);
  }
  return ranges;
}

function likelyDollarMath(content: string): boolean {
  if (!content || /^\s|\s$/.test(content) || content.includes("\n")) return false;
  // Currency in prose: "$5 and $10", "$33,055 and ... $33,055".
  if (/^\d[\d,.]*$/.test(content) || (/^\d/.test(content) && /,/.test(content))) return false;
  // Plain words ("$HOME and $PATH") and shell/quoted text are not math.
  if (/^[A-Za-z]+(?:\s+[A-Za-z0-9]+)+$/.test(content) || /["`]/.test(content)) return false;
  return /[A-Za-z0-9α-ωΑ-Ω\\_^=+*/<>()[\]{}|−∞∑∫]/u.test(content);
}

/** Prose rather than TeX between two `$$` that are not on their own lines. */
function likelyProse(content: string): boolean {
  return /^\s*[A-Za-z]+(?:[\s,.'’]+[A-Za-z]+){2,}[\s,.]*$/.test(content);
}

class Scanner {
  private readonly blankLines: number[] = [];
  private readonly fences: Array<[number, number]>;
  private readonly searches = new Map<string, { from: number; found: number }>();

  constructor(private readonly text: string) {
    this.fences = fencedRanges(text);
    for (const match of text.matchAll(/\n[ \t]*(?=\n)/g)) this.blankLines.push(match.index);
  }

  /** End of the paragraph containing `index` (the next blank line or fence). */
  paragraphEnd(index: number): number {
    let end = this.text.length;
    for (const blank of this.blankLines) {
      if (blank >= index) {
        end = blank;
        break;
      }
    }
    return Math.min(end, this.nextFenceStart(index));
  }

  nextFenceStart(index: number): number {
    for (const [start] of this.fences) if (start >= index) return start;
    return this.text.length;
  }

  fenceAt(index: number): [number, number] | null {
    for (const range of this.fences) if (index >= range[0] && index < range[1]) return range;
    return null;
  }

  /** Next unescaped `token` at or after `from`, cached so repeated misses stay linear. */
  nextUnescaped(token: string, from: number): number {
    const cached = this.searches.get(token);
    if (cached && from >= cached.from && (cached.found < 0 || cached.found >= from)) return cached.found;
    let found = this.text.indexOf(token, from);
    while (found >= 0 && isEscaped(this.text, found)) found = this.text.indexOf(token, found + 1);
    this.searches.set(token, { from, found });
    return found;
  }

  isStandaloneOpener(start: number): boolean {
    const lineStart = this.text.lastIndexOf("\n", start - 1) + 1;
    return /^[ \t]*(?:>[ \t]?)*[ \t]*$/.test(this.text.slice(lineStart, start));
  }

  isStandaloneCloser(end: number): boolean {
    const lineEnd = this.text.indexOf("\n", end);
    return /^[ \t]*[.,;:!?]?[ \t]*$/.test(this.text.slice(end, lineEnd < 0 ? this.text.length : lineEnd));
  }
}

function blockquoteClean(text: string, start: number, tex: string): string {
  if (!tex.includes("\n")) return tex;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (!QUOTE_PREFIX.test(text.slice(lineStart, start)) || !text.slice(lineStart, start).includes(">")) return tex;
  return tex.split("\n").map((current, index) => index === 0 ? current : current.replace(QUOTE_PREFIX, "")).join("\n");
}

function scanMath(text: string): MathScan {
  const fragments: MathFragment[] = [];
  const escapedDollars: number[] = [];
  if (!/[$\\]/.test(text)) return { fragments, escapedDollars };
  const scanner = new Scanner(text);
  const push = (start: number, contentStart: number, contentEnd: number, end: number, delimiter: MathDelimiter, display: boolean) => {
    const raw = delimiter === "env" ? text.slice(start, end) : text.slice(contentStart, contentEnd);
    fragments.push({ tex: blockquoteClean(text, start, raw), display, delimiter, start, end });
  };

  let i = 0;
  while (i < text.length) {
    const fence = text[i] === "`" || i === 0 || text[i - 1] === "\n" ? scanner.fenceAt(i) : null;
    if (fence) {
      i = fence[1];
      continue;
    }
    const char = text[i];

    if (char === "`") {
      const ticks = countRun(text, i, "`");
      const limit = scanner.paragraphEnd(i);
      let close = -1;
      for (let j = i + ticks; j < limit;) {
        if (text[j] !== "`") {
          j++;
          continue;
        }
        const run = countRun(text, j, "`");
        if (run === ticks) {
          close = j;
          break;
        }
        j += run;
      }
      i = close >= 0 ? close + ticks : i + ticks;
      continue;
    }

    if (char === "\\") {
      const next = text[i + 1];
      if (next === "$") {
        escapedDollars.push(i);
        i += 2;
        continue;
      }
      if (next === "(" || next === "[") {
        const display = next === "[";
        const closer = display ? "\\]" : "\\)";
        const close = scanner.nextUnescaped(closer, i + 2);
        const limit = display ? scanner.nextFenceStart(i) : scanner.paragraphEnd(i);
        if (close >= 0 && close <= limit && text.slice(i + 2, close).trim()) {
          const crossesParagraph = display && close > scanner.paragraphEnd(i);
          if (!crossesParagraph || (scanner.isStandaloneOpener(i) && scanner.isStandaloneCloser(close + 2))) {
            push(i, i + 2, close, close + 2, display ? "\\[" : "\\(", display);
            i = close + 2;
            continue;
          }
        }
        i += 2;
        continue;
      }
      if (text.startsWith("\\begin{", i)) {
        const environment = readBareEnvironment(text, i, scanner.nextFenceStart(i));
        if (environment) {
          push(i, i, environment, environment, "env", true);
          i = environment;
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (char === "$") {
      if (text[i + 1] === "$") {
        if (text[i + 2] === "$") {
          i += countRun(text, i, "$");
          continue;
        }
        const close = scanner.nextUnescaped("$$", i + 2);
        if (close >= 0 && close < scanner.nextFenceStart(i)) {
          const content = text.slice(i + 2, close);
          const standalone = scanner.isStandaloneOpener(i) && scanner.isStandaloneCloser(close + 2);
          const crossesParagraph = close > scanner.paragraphEnd(i);
          if (content.trim() && (standalone || (!crossesParagraph && !likelyProse(content)))) {
            push(i, i + 2, close, close + 2, "$$", true);
            i = close + 2;
            continue;
          }
        }
        i += 2;
        continue;
      }
      const lineEnd = text.indexOf("\n", i);
      const limit = lineEnd < 0 ? text.length : lineEnd;
      let close = -1;
      for (let j = i + 1; j < limit; j++) {
        if (text[j] === "$" && !isEscaped(text, j)) {
          close = j;
          break;
        }
      }
      // Shell and template text ("$HOME", PATH="$JAVA_HOME/bin:$PATH", US$5)
      // puts the dollar right after a word, quote or `=`.
      const opensWord = /[A-Za-z0-9"'=/]/.test(text[i - 1] ?? "");
      if (close >= 0 && !opensWord && text[close + 1] !== "$" && !/[0-9_]/.test(text[close + 1] ?? "")) {
        const content = text.slice(i + 1, close);
        if (likelyDollarMath(content)) {
          push(i, i + 1, close, close + 1, "$", false);
          i = close + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return { fragments, escapedDollars };
}

/** End offset of a bare `\begin{env}…\end{env}` math environment, or null. */
function readBareEnvironment(text: string, start: number, limit: number): number | null {
  const opening = /^\\begin\{([A-Za-z]+\*?)\}/.exec(text.slice(start, start + 40));
  if (!opening || !BARE_MATH_ENVIRONMENTS.test(opening[1])) return null;
  const boundaries = /\\(begin|end)\{([^}\n]+)\}/g;
  boundaries.lastIndex = start + opening[0].length;
  let depth = 1;
  for (let match; (match = boundaries.exec(text));) {
    if (match.index >= limit) return null;
    if (isEscaped(text, match.index)) continue;
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) return match[2] === opening[1] ? boundaries.lastIndex : null;
  }
  return null;
}

/**
 * Find delimited math in an assistant Markdown message: `$…$`, `$$…$$`,
 * `\(…\)`, `\[…\]` and bare math environments. Fenced code blocks and inline
 * code spans are skipped, `\$` is an escaped dollar, and prose prices such as
 * "$5 and $10" are not math.
 */
export function findMathFragments(markdown: string): MathFragment[] {
  return scanMath(markdown).fragments;
}

// ── Inline rendering ───────────────────────────────────────────────────

interface InlineRender {
  /** Rendered lines; a fragment spanning a newline joins its lines. */
  lines: string[];
  /**
   * Per rendered line: the copy text with math as its original TeX (and
   * Markdown markers stripped like the rendered line), or null when the line
   * has no math.
   */
  sources: Array<string | null>;
}

const PLACEHOLDER_BASE = 0xE100;

function renderInline(text: string, nbsp: boolean): InlineRender {
  const { fragments, escapedDollars } = scanMath(text);
  if (fragments.length === 0 && escapedDollars.length === 0) {
    const lines = text.split("\n");
    return { lines, sources: lines.map(() => null) };
  }

  const rendered: string[] = [""];
  const raw: string[] = [""];
  const mathSources: string[][] = [[]];
  const appendText = (from: number, to: number) => {
    let cursor = from;
    for (const escape of escapedDollars) {
      if (escape < from || escape >= to) continue;
      appendPlain(text.slice(cursor, escape) + "$");
      cursor = escape + 2;
    }
    appendPlain(text.slice(cursor, to));
  };
  const appendPlain = (piece: string) => {
    const parts = piece.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        rendered.push("");
        raw.push("");
        mathSources.push([]);
      }
      rendered[rendered.length - 1] += part;
      raw[raw.length - 1] += part;
    });
  };

  let cursor = 0;
  for (const fragment of fragments) {
    appendText(cursor, fragment.start);
    const sources = mathSources[mathSources.length - 1];
    const placeholder = String.fromCodePoint(PLACEHOLDER_BASE + Math.min(sources.length, 0x17FF));
    sources.push(text.slice(fragment.start, fragment.end).replace(/\s*\n\s*/g, " "));
    rendered[rendered.length - 1] += inlineMath(fragment.tex, nbsp);
    raw[raw.length - 1] += placeholder;
    cursor = fragment.end;
  }
  appendText(cursor, text.length);

  const sources = raw.map((line, index) => {
    const math = mathSources[index];
    if (math.length === 0) return null;
    const plain = stripMarkdown(line).trim();
    return plain.replace(/[-]/g, char => math[char.codePointAt(0)! - PLACEHOLDER_BASE] ?? char);
  });
  return { lines: rendered, sources };
}

/** Convert inline math while leaving Markdown code spans and ordinary currency alone. */
export function renderInlineMath(input: string): string {
  if (!input || !/[$\\]/.test(input)) return input;
  return renderInline(input, false).lines.join("\n");
}

/**
 * Render the physical lines of one paragraph as a single inline context, so
 * code spans and `\(…\)` may cross hard newlines. A fragment spanning lines
 * joins them.
 */
export function renderInlineMathChunks(lines: string[]): string[] {
  return renderInlineMathLines(lines).lines;
}

/**
 * renderInlineMathChunks plus per-line copy sources with math as TeX. Math
 * uses no-break spaces so wrapping only splits it after relations/operators.
 */
export function renderInlineMathLines(lines: string[]): InlineRender {
  if (!lines.some(current => /[$\\]/.test(current))) return { lines, sources: lines.map(() => null) };
  return renderInline(lines.join("\n"), true);
}

// ── Display blocks ─────────────────────────────────────────────────────

export interface DisplayMathBlock {
  source: string;
  nextLine: number;
}

/** Read a standalone `\[ ... \]` or `$$ ... $$` block from physical lines. */
export function takeDisplayMathBlock(lines: string[], start: number): DisplayMathBlock | null {
  const line = lines[start] ?? "";
  const leading = line.match(/^\s*/)?.[0].length ?? 0;
  const opener = line.startsWith("\\[", leading) ? "\\["
    : line.startsWith("$$", leading) && line[leading + 2] !== "$" ? "$$" : null;
  if (!opener) return null;
  const closer = opener === "\\[" ? "\\]" : "$$";

  const chunks: string[] = [];
  let current = line.slice(leading + opener.length);
  for (let index = start; index < lines.length; index++) {
    if (index > start) current = lines[index];
    let close = current.indexOf(closer);
    while (close >= 0 && isEscaped(current, close)) close = current.indexOf(closer, close + 1);
    if (close >= 0) {
      if (current.slice(close + closer.length).trim() !== "") return null;
      chunks.push(current.slice(0, close));
      return { source: chunks.join("\n"), nextLine: index + 1 };
    }
    chunks.push(current);
  }
  return null;
}

export interface LocatedDisplayMathBlock extends DisplayMathBlock {
  startLine: number;
}

/** Display fragments of `lines[start..end)` that begin and end on their own lines. */
export function findDisplayMathBlocks(lines: string[], start: number, end: number): LocatedDisplayMathBlock[] {
  const text = lines.slice(start).join("\n");
  const lineOf = (offset: number) => start + text.slice(0, offset).split("\n").length - 1;
  const paragraphEnd = lines.slice(start, end).join("\n").length;
  const blocks: LocatedDisplayMathBlock[] = [];
  for (const fragment of findMathFragments(text)) {
    if (!fragment.display || fragment.start > paragraphEnd || fragment.delimiter === "env") continue;
    const lineStart = text.lastIndexOf("\n", fragment.start - 1) + 1;
    const lineEnd = text.indexOf("\n", fragment.end);
    if (text.slice(lineStart, fragment.start).trim() || text.slice(fragment.end, lineEnd < 0 ? text.length : lineEnd).trim()) continue;
    blocks.push({ startLine: lineOf(fragment.start), source: fragment.tex, nextLine: lineOf(fragment.end) + 1 });
  }
  return blocks;
}

export interface RenderedDisplayMath {
  lines: string[];
  cont: boolean[];
  join: string[];
  copy: Array<WrapCopyLine | null>;
}

export interface DisplayMathOptions {
  /** Original delimited source; whole-line copies of the block yield it. */
  source?: string;
  /** Punctuation that followed the closing delimiter, kept after the last row. */
  trailing?: string;
}

/**
 * Render a display expression as an indented block. Rows after the first are
 * continuations of one logical line, so a line yank copies the whole block
 * (as its TeX source when `options.source` is given).
 */
export function renderDisplayMath(source: string, width: number, options: DisplayMathOptions = {}): RenderedDisplayMath {
  const safeWidth = Math.max(1, width);
  const indent = safeWidth >= 24 ? 2 : 0;
  const trailing = options.trailing ?? "";
  const layout = displayRows(source, safeWidth - indent - termWidth(trailing));
  const rows = layout.rows.length > 0 ? layout.rows : [""];
  if (trailing) {
    const base = Math.min(layout.lastBase, rows.length - 1);
    const end = Math.max(...rows.map(row => termWidth(row)));
    // Align after the widest row so stacked fractions keep their columns.
    rows[base] += " ".repeat(Math.max(0, end - termWidth(rows[base]))) + trailing;
  }

  const pad = " ".repeat(indent);
  const lines = rows.map(row => (row ? pad + row : row));
  const copy = rows.map((row, index): WrapCopyLine => ({
    text: row,
    displayStart: row ? indent : 0,
    ...(options.source !== undefined ? { source: index === 0 ? options.source : null } : {}),
  }));
  return {
    lines,
    cont: rows.map((_, index) => index > 0),
    join: rows.map((_, index) => (index > 0 ? "\n" : "")),
    copy,
  };
}

export interface ExtractedDisplayMath {
  /** Markdown with each display fragment replaced by one placeholder line. */
  text: string;
  blocks: Array<{
    tex: string;
    /** Original delimited source (list indentation removed) for copies. */
    source: string;
    /** Indentation or blockquote markers to repeat before each rendered row. */
    prefix: string;
    trailing: string;
  }>;
}

/** A block's source lines without the indentation they share with its opening line (a list item's). */
function blockSource(source: string, prefix: string): string {
  if (!source.includes("\n") || prefix.includes(">")) return source;
  const lines = (prefix + source).split("\n");
  const indent = Math.min(...lines.filter(current => current.trim()).map(current => /^[ \t]*/.exec(current)![0].length));
  return lines.map(current => current.slice(Math.min(indent, /^[ \t]*/.exec(current)![0].length)).trimEnd()).join("\n");
}

export const DISPLAY_PLACEHOLDER = /^(\d+)$/;

/**
 * Move every display fragment onto its own line so the Markdown wrapper can
 * render it as a block, even when it appears mid-paragraph. `keepInline`
 * vetoes lines (such as table rows) where blocks cannot be placed.
 */
export function extractDisplayMath(text: string, keepInline: (line: string) => boolean = () => false): ExtractedDisplayMath | null {
  if (!/[$\\]/.test(text) || /[]/.test(text)) return null;
  const fragments = findMathFragments(text).filter(fragment => {
    if (!fragment.display) return false;
    const lineStart = text.lastIndexOf("\n", fragment.start - 1) + 1;
    const lineEnd = text.indexOf("\n", lineStart);
    return !keepInline(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd));
  });
  if (fragments.length === 0) return null;

  const blocks: ExtractedDisplayMath["blocks"] = [];
  let out = "";
  let cursor = 0;
  let prefix = "";
  /** The cursor is in the middle of the line a display fragment closed on. */
  let afterFragment = false;
  const newline = () => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  /** Copy source text, starting any rest-of-line after a fragment on its own line. */
  const emit = (lead: string, quote: string) => {
    let rest = lead;
    if (afterFragment) {
      const lineBreak = rest.indexOf("\n");
      const sameLine = lineBreak < 0 ? rest : rest.slice(0, lineBreak);
      if (sameLine.trim()) {
        newline();
        out += prefix + sameLine.trim();
      }
      if (lineBreak < 0) return;
      rest = rest.slice(lineBreak);
    }
    const lastBreak = rest.lastIndexOf("\n");
    out += rest.slice(0, lastBreak + 1);
    const sameLine = rest.slice(lastBreak + 1);
    if (sameLine.trim() && sameLine.trim() !== quote.trim()) out += sameLine.trimEnd();
  };
  fragments.forEach((fragment, index) => {
    const lineStart = text.lastIndexOf("\n", fragment.start - 1) + 1;
    // The line the fragment closes on (it may span several lines).
    const lineEndIndex = text.indexOf("\n", fragment.end);
    const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
    const lineLead = text.slice(lineStart, fragment.start);
    const quote = lineLead.match(QUOTE_PREFIX)?.[0] ?? "";
    if (!afterFragment || cursor < lineStart) {
      emit(text.slice(cursor, fragment.start), quote);
      prefix = quote.includes(">") ? quote : lineLead.match(/^[ \t]*/)?.[0] ?? "";
    } else {
      emit(text.slice(cursor, fragment.start), quote);
    }
    newline();
    out += `${prefix}\uE0F0${blocks.length}\uE0F1`;

    const nextOnLine = fragments[index + 1] !== undefined && fragments[index + 1].start < lineEnd;
    const after = text.slice(fragment.end, lineEnd);
    const trailing = !nextOnLine && /^[ \t]*[.,;:!?]?[ \t]*$/.test(after) ? after.trim() : "";
    blocks.push({ tex: fragment.tex, source: blockSource(text.slice(fragment.start, fragment.end), prefix), prefix, trailing });
    afterFragment = nextOnLine || after.trim() !== "" && !trailing;
    cursor = afterFragment ? fragment.end : lineEnd;
  });
  emit(text.slice(cursor), "");
  return { text: out, blocks };
}
