import { theme } from "../theme";
import { hardBreak, sliceByWidth, termWidth, visibleLength } from "../textwidth";

export { hardBreak, sliceByWidth, termWidth, visibleLength } from "../textwidth";

// Markdown-specific background not in the theme system
const BG_CODE = "\x1b[48;2;22;32;48m"; // #162030 subtle tint for inline code

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

// Find closing `marker` in `src` starting from `from`, skipping over
// inline code spans so that markers inside code are not matched.
// Requires at least one character of content (i.e. the closing marker
// must be at a position > from).
function findClosing(src: string, from: number, marker: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      const ticks = countRun(src, i, '`');
      const end = findCodeSpanClose(src, i + ticks, ticks);
      if (end >= 0) { i = end + ticks; continue; }
    }
    if (i > from && src.startsWith(marker, i)) return i;
    i++;
  }
  return -1;
}

function findCodeSpanClose(src: string, from: number, ticks: number): number {
  if (ticks < 1 || from >= src.length) return -1;
  let i = from;
  while (i < src.length) {
    if (src[i] !== '`') {
      i++;
      continue;
    }
    const closeTicks = countRun(src, i, '`');
    if (closeTicks === ticks && i > from) return i;
    i += closeTicks;
  }
  return -1;
}

// Single-pass recursive scanner for all inline markdown formatting.
// Builds `text` (with ANSI codes) and `plain` (markers stripped) in
// lockstep so they always consume the exact same characters.
function scan(src: string, bgRestore: string): { text: string; plain: string } {
  let text = "";
  let plain = "";
  let i = 0;

  while (i < src.length) {
    // Try bold+italic: ***...***
    if (i + 2 < src.length && src[i] === '*' && src[i + 1] === '*' && src[i + 2] === '*') {
      const close = findClosing(src, i + 3, '***');
      if (close >= 0) {
        const inner = scan(src.slice(i + 3, close), bgRestore);
        text += theme.bold + theme.italic + inner.text + theme.italicOff + theme.boldOff;
        plain += inner.plain;
        i = close + 3;
        continue;
      }
    }

    // Try bold: **...**
    if (i + 1 < src.length && src[i] === '*' && src[i + 1] === '*') {
      const close = findClosing(src, i + 2, '**');
      if (close >= 0) {
        const inner = scan(src.slice(i + 2, close), bgRestore);
        text += theme.bold + inner.text + theme.boldOff;
        plain += inner.plain;
        i = close + 2;
        continue;
      }
    }

    // Try italic: *...*
    if (src[i] === '*') {
      const close = findClosing(src, i + 1, '*');
      if (close >= 0) {
        const inner = scan(src.slice(i + 1, close), bgRestore);
        text += theme.italic + inner.text + theme.italicOff;
        plain += inner.plain;
        i = close + 1;
        continue;
      }
    }

    // Try inline code spans with 1+ backticks (leaf node — content not recursed)
    if (src[i] === '`') {
      const ticks = countRun(src, i, '`');
      const close = findCodeSpanClose(src, i + ticks, ticks);
      if (close >= 0) {
        const content = src.slice(i + ticks, close);
        text += BG_CODE + content + bgRestore;
        plain += content;
        i = close + ticks;
        continue;
      }
    }

    // Regular character
    text += src[i];
    plain += src[i];
    i++;
  }

  return { text, plain };
}

// Light markdown formatting: **bold**, *italic*, `code`
// Returns ANSI-formatted text and a plain version with markers stripped.
// bgRestore is the ANSI escape to restore after inline code spans.
//
// Uses a single recursive scanner.  Bold/italic are the outer layers and
// can wrap code spans; code spans are leaf nodes whose contents are
// protected from further formatting.  Priority: *** > ** > * > `.
export function formatMarkdown(line: string, bgRestore: string): { text: string; plain: string } {
  return scan(line, bgRestore);
}

// Strip markdown markers to get visible text.  Reuses the same scanner
// as formatMarkdown so width calculations always agree with rendering.
export function stripMarkdown(s: string): string {
  return formatMarkdown(s, "").plain;
}
