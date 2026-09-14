import { hexToAnsiBg, theme } from "../theme";
import { inlineLinkAt, type LinkSpan } from "../links";

export { hardBreak, sliceByWidth, termWidth, visibleLength } from "../textwidth";

// Markdown-specific background not in the theme system
const BG_CODE = hexToAnsiBg("#162030"); // subtle tint for inline code

// --- Horizontal rule detection ---
// Matches CommonMark horizontal rules: 3+ of -, *, or _ with optional
// spaces/tabs between them.
export function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])([ \t]*\1){2,}\s*$/.test(line);
}

function countRun(src: string, from: number, ch: string): number {
  let i = from;
  while (i < src.length && src[i] === ch) i++;
  return i - from;
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  code: boolean;
  link?: string;
}

interface StyledToken {
  ch: string;
  chunk: number;
  style: InlineStyle;
}

const PLAIN_STYLE: InlineStyle = { bold: false, italic: false, code: false };

function withStyle(style: InlineStyle, patch: Partial<InlineStyle>): InlineStyle {
  return { ...style, ...patch };
}

function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link;
}

function hasValidEmphasisContent(src: string, from: number, close: number, marker: string): boolean {
  if (close <= from || /\s/.test(src[from] ?? "")) return false;

  // Avoid treating consecutive `* item` list bullets as one multi-line italic
  // span.  This renderer does not implement list syntax, but a lone `*` at
  // the start of a line followed by whitespace is much more likely to be a
  // bullet marker than an emphasis closer.
  if (marker === "*" && (close === 0 || src[close - 1] === "\n") && /\s/.test(src[close + 1] ?? "")) {
    return false;
  }

  return true;
}

// Single-pass recursive scanner for all inline markdown formatting.
// Builds `text` (with ANSI codes) and `plain` (markers stripped) in
// lockstep so they always consume the exact same characters.
function scan(src: string, bgRestore: string): { text: string; plain: string } {
  const tokens: StyledToken[] = [];
  scanStyledTokens(src, 0, src.length, Array(src.length).fill(0), PLAIN_STYLE, tokens);
  return { text: renderStyledTokens(tokens, bgRestore), plain: tokens.map(token => token.ch).join("") };
}

function findClosingInRange(src: string, from: number, marker: string, end: number): number {
  let i = from;
  while (i < end) {
    if (src[i] === '`') {
      const ticks = countRun(src, i, '`');
      const codeEnd = findCodeSpanCloseInRange(src, i + ticks, ticks, end);
      if (codeEnd >= 0) { i = codeEnd + ticks; continue; }
    }
    if (i > from && i + marker.length <= end && src.startsWith(marker, i)) return i;
    i++;
  }
  return -1;
}

function findCodeSpanCloseInRange(src: string, from: number, ticks: number, end: number): number {
  if (ticks < 1 || from >= end) return -1;
  let i = from;
  while (i < end) {
    if (src[i] !== '`') {
      i++;
      continue;
    }
    const closeTicks = countRun(src, i, '`');
    if (closeTicks === ticks && i > from && i + closeTicks <= end) return i;
    i += closeTicks;
  }
  return -1;
}

function scanStyledTokens(
  src: string,
  start: number,
  end: number,
  owner: number[],
  style: InlineStyle,
  out: StyledToken[],
): void {
  let i = start;

  while (i < end) {
    // Try bold+italic: ***...***
    const link = !style.link ? inlineLinkAt(src, i, end) : null;
    if (link) {
      const linkStyle = withStyle(style, { link: link.target });
      if (src[i] === "[") {
        scanStyledTokens(src, link.labelStart, link.labelEnd, owner, linkStyle, out);
      } else {
        // URL punctuation is data, not emphasis syntax.
        for (let j = link.labelStart; j < link.labelEnd; j++) {
          if (owner[j] >= 0) out.push({ ch: src[j], chunk: owner[j], style: linkStyle });
        }
      }
      i = link.end;
      continue;
    }

    if (i + 2 < end && src[i] === '*' && src[i + 1] === '*' && src[i + 2] === '*') {
      const close = findClosingInRange(src, i + 3, '***', end);
      if (close >= 0 && hasValidEmphasisContent(src, i + 3, close, '***')) {
        scanStyledTokens(src, i + 3, close, owner, withStyle(style, { bold: true, italic: true }), out);
        i = close + 3;
        continue;
      }
    }

    // Try bold: **...**
    if (i + 1 < end && src[i] === '*' && src[i + 1] === '*') {
      const close = findClosingInRange(src, i + 2, '**', end);
      if (close >= 0 && hasValidEmphasisContent(src, i + 2, close, '**')) {
        scanStyledTokens(src, i + 2, close, owner, withStyle(style, { bold: true }), out);
        i = close + 2;
        continue;
      }
    }

    // Try italic: *...*
    if (src[i] === '*') {
      const close = findClosingInRange(src, i + 1, '*', end);
      if (close >= 0 && hasValidEmphasisContent(src, i + 1, close, '*')) {
        scanStyledTokens(src, i + 1, close, owner, withStyle(style, { italic: true }), out);
        i = close + 1;
        continue;
      }
    }

    // Try inline code spans with 1+ backticks (leaf node — content not recursed)
    if (src[i] === '`') {
      const ticks = countRun(src, i, '`');
      const close = findCodeSpanCloseInRange(src, i + ticks, ticks, end);
      if (close >= 0) {
        for (let j = i + ticks; j < close; j++) {
          const chunk = owner[j];
          if (chunk >= 0) out.push({ ch: src[j], chunk, style: withStyle(style, { code: true }) });
        }
        i = close + ticks;
        continue;
      }
    }

    // Regular character. Separators inserted only for parsing (owner -1) are
    // deliberately not emitted into any rendered visual line.
    const chunk = owner[i];
    if (chunk >= 0) out.push({ ch: src[i], chunk, style });
    i++;
  }
}

function renderStyledTokens(tokens: StyledToken[], bgRestore: string): string {
  let text = "";
  let active = { ...PLAIN_STYLE };
  const setStyle = (desired: InlineStyle) => {
    if (sameStyle(active, desired)) return;
    if (active.code || desired.code) {
      if (active.bold || active.italic || active.code) text += bgRestore;
      if (active.bold && !desired.bold) text += theme.boldOff;
      if (active.italic && !desired.italic) text += theme.italicOff;
      if (desired.bold) text += theme.bold;
      if (desired.italic) text += theme.italic;
      if (desired.code) text += BG_CODE;
    } else {
      if (active.bold && !desired.bold) text += theme.boldOff;
      if (active.italic && !desired.italic) text += theme.italicOff;
      if (!active.bold && desired.bold) text += theme.bold;
      if (!active.italic && desired.italic) text += theme.italic;
    }
    if (active.link !== desired.link || active.code || desired.code) {
      if (desired.link) text += theme.link;
      else if (active.link) text += theme.text;
    }
    active = { ...desired };
  };

  for (const token of tokens) {
    setStyle(token.style);
    text += token.ch;
  }
  setStyle(PLAIN_STYLE);
  return text;
}

function buildChunkSource(chunks: string[], joins: string[]): { src: string; owner: number[] } {
  let src = "";
  const owner: number[] = [];

  for (let chunk = 0; chunk < chunks.length; chunk++) {
    const join = chunk === 0 ? "" : (joins[chunk] ?? "");
    for (let i = 0; i < join.length; i++) {
      src += join[i];
      owner.push(-1);
    }
    for (let i = 0; i < chunks[chunk].length; i++) {
      src += chunks[chunk][i];
      owner.push(chunk);
    }
  }

  return { src, owner };
}

// Light markdown formatting: **bold**, *italic*, `code`, and HTTP(S) links.
// Returns ANSI-formatted text and a plain version with markers stripped.
// bgRestore is the ANSI escape to restore after inline code spans.
//
// Uses a single recursive scanner.  Bold/italic are the outer layers and
// can wrap code spans; code spans are leaf nodes whose contents are
// protected from further formatting.  Priority: *** > ** > * > `.
export function formatMarkdown(line: string, bgRestore: string): { text: string; plain: string } {
  return scan(line, bgRestore);
}

// Format chunks that are rendered as separate visual lines but should be parsed
// as one markdown inline context.  `joins[i]` is the invisible source text to
// insert before chunks[i] while looking for closing delimiters (for example a
// soft-wrap space, a hard-newline, or "" for a hard break inside a long word).
export function formatMarkdownChunks(chunks: string[], joins: string[], bgRestore: string): string[] {
  return formatMarkdownChunksWithLinks(chunks, joins, bgRestore).lines;
}

export function formatMarkdownChunksWithLinks(chunks: string[], joins: string[], bgRestore: string): { lines: string[]; links: LinkSpan[][] } {
  const { src, owner } = buildChunkSource(chunks, joins);
  const tokens: StyledToken[] = [];
  scanStyledTokens(src, 0, src.length, owner, PLAIN_STYLE, tokens);

  const byChunk: StyledToken[][] = chunks.map(() => []);
  for (const token of tokens) {
    byChunk[token.chunk]?.push(token);
  }

  const links = byChunk.map(chunkTokens => {
    const spans: LinkSpan[] = [];
    let offset = 0;
    for (const token of chunkTokens) {
      const previous = spans.at(-1);
      if (token.style.link) {
        if (previous?.target === token.style.link && previous.end === offset) previous.end += token.ch.length;
        else spans.push({ start: offset, end: offset + token.ch.length, target: token.style.link });
      }
      offset += token.ch.length;
    }
    return spans;
  });
  return { lines: byChunk.map(chunkTokens => renderStyledTokens(chunkTokens, bgRestore)), links };
}

// Strip markdown markers to get visible text.  Reuses the same scanner
// as formatMarkdown so width calculations always agree with rendering.
export function stripMarkdown(s: string): string {
  if (!/[*`\[<]|https?:\/\//i.test(s)) return s;
  return formatMarkdown(s, "").plain;
}
