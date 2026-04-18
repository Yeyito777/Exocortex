import { theme } from "../theme";

// Markdown-specific background not in the theme system
const BG_CODE = "\x1b[48;2;22;32;48m"; // #162030 subtle tint for inline code

// --- Terminal-aware character width ---
// JavaScript .length counts UTF-16 code units, not terminal columns.
// Emoji like ✅ (U+2705) and CJK characters occupy 2 columns in a terminal
// but .length reports 1 or 2.  This causes table column misalignment.

// Sorted ranges of always-double-width codepoints [start, end] (inclusive).
// Sources: Unicode 15.0 East Asian Width W/F + Emoji_Presentation=Yes.
// Characters with Emoji_Presentation=No (text by default) are NOT here —
// they become wide only when followed by VS16 (U+FE0F), handled in termWidth.
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115F],   // Hangul Jamo
  [0x231A, 0x231B],   // Watch, Hourglass
  [0x2329, 0x232A],   // Angle Brackets
  [0x23E9, 0x23EC],   // ⏩–⏬
  [0x23F0, 0x23F0],   // ⏰
  [0x23F3, 0x23F3],   // ⏳
  [0x25FD, 0x25FE],   // ◽◾
  // BMP emoji — ONLY Emoji_Presentation=Yes characters that wcswidth()
  // reports as 2 columns.  EP=No characters (☠ ❤ ✂ ☎ etc.) are 1 col
  // in most terminals and are excluded.
  [0x2614, 0x2615],   // ☔☕
  [0x2648, 0x2653],   // ♈–♓
  [0x267F, 0x267F],   // ♿
  [0x2693, 0x2693],   // ⚓
  [0x26A1, 0x26A1],   // ⚡
  [0x26AA, 0x26AB],   // ⚪⚫
  [0x26BD, 0x26BE],   // ⚽⚾
  [0x26C4, 0x26C5],   // ⛄⛅
  [0x26CE, 0x26CE],   // ⛎
  [0x26D4, 0x26D4],   // ⛔
  [0x26EA, 0x26EA],   // ⛪
  [0x26F2, 0x26F3],   // ⛲⛳
  [0x26F5, 0x26F5],   // ⛵
  [0x26FA, 0x26FA],   // ⛺
  [0x26FD, 0x26FD],   // ⛽
  [0x2705, 0x2705],   // ✅
  [0x270A, 0x270B],   // ✊✋
  [0x2728, 0x2728],   // ✨
  [0x274C, 0x274C],   // ❌
  [0x274E, 0x274E],   // ❎
  [0x2753, 0x2755],   // ❓–❕
  [0x2757, 0x2757],   // ❗
  [0x2795, 0x2797],   // ➕–➗
  [0x27B0, 0x27B0],   // ➰
  [0x27BF, 0x27BF],   // ➿
  [0x2B1B, 0x2B1C],   // ⬛⬜
  [0x2B50, 0x2B50],   // ⭐
  [0x2B55, 0x2B55],   // ⭕
  // East Asian Wide: CJK & related
  [0x2E80, 0x9FFF],   // CJK Radicals → CJK Unified Ideographs
  [0xA000, 0xA4CF],   // Yi Syllables & Radicals
  [0xAC00, 0xD7AF],   // Hangul Syllables
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0xFE10, 0xFE19],   // Vertical Forms
  [0xFE30, 0xFE6F],   // CJK Compatibility Forms
  [0xFF01, 0xFF60],   // Fullwidth Forms
  [0xFFE0, 0xFFE6],   // Fullwidth Signs
  // Supplementary emoji — only Emoji_Presentation=Yes (always wide).
  // Characters like 🕷 (U+1F577) that have EP=No are excluded;
  // they become wide only when VS16 follows (see termWidth).
  [0x1F004, 0x1F004],   // 🀄
  [0x1F0CF, 0x1F0CF],   // 🃏
  // 🅰🅱🅾🅿 (U+1F170–1F17F) removed: EP=No, wcswidth=1
  [0x1F18E, 0x1F18E],   // 🆎
  [0x1F191, 0x1F19A],   // 🆑–🆚
  // Regional Indicators (U+1F1E6–1F1FF) removed from table:
  // individually 1 col; paired as flags via nextGrapheme()
  [0x1F201, 0x1F202],   // 🈁🈂
  [0x1F21A, 0x1F21A],   // 🈚
  [0x1F22F, 0x1F22F],   // 🈯
  [0x1F232, 0x1F23A],   // 🈲–🈺
  [0x1F250, 0x1F251],   // 🉐🉑
  [0x1F300, 0x1F320],   // 🌀–🌠
  [0x1F32D, 0x1F335],   // 🌭–🌵
  [0x1F337, 0x1F37C],   // 🌷–🍼
  [0x1F37E, 0x1F393],   // 🍾–🎓
  [0x1F3A0, 0x1F3CA],   // 🎠–🏊
  [0x1F3CF, 0x1F3D3],   // 🏏–🏓
  [0x1F3E0, 0x1F3F0],   // 🏠–🏰
  [0x1F3F4, 0x1F3F4],   // 🏴
  [0x1F3F8, 0x1F43E],   // 🏸–🐾
  [0x1F440, 0x1F440],   // 👀
  [0x1F442, 0x1F4FC],   // 👂–📼
  [0x1F4FF, 0x1F53D],   // 📿–🔽
  [0x1F54B, 0x1F54E],   // 🕋–🕎
  [0x1F550, 0x1F567],   // 🕐–🕧
  [0x1F57A, 0x1F57A],   // 🕺
  [0x1F595, 0x1F596],   // 🖕🖖
  [0x1F5A4, 0x1F5A4],   // 🖤
  [0x1F5FB, 0x1F64F],   // 🗻–🙏
  [0x1F680, 0x1F6C5],   // 🚀–🛅
  [0x1F6CC, 0x1F6CC],   // 🛌
  [0x1F6D0, 0x1F6D2],   // 🛐–🛒
  [0x1F6D5, 0x1F6D7],   // 🛕–🛗
  [0x1F6DD, 0x1F6DF],   // 🛝–🛟
  [0x1F6EB, 0x1F6EC],   // 🛫🛬
  [0x1F6F4, 0x1F6FC],   // 🛴–🛼
  [0x1F7E0, 0x1F7EB],   // 🟠–🟫
  [0x1F7F0, 0x1F7F0],   // 🟰
  [0x1F90C, 0x1F93A],   // 🤌–🤺
  [0x1F93C, 0x1F945],   // 🤼–🥅
  [0x1F947, 0x1F9FF],   // 🥇–🧿
  [0x1FA70, 0x1FA74],   // 🩰–🩴
  [0x1FA78, 0x1FA7C],   // 🩸–🩼
  [0x1FA80, 0x1FA86],   // 🪀–🪆
  [0x1FA90, 0x1FAAC],   // 🪐–🫬
  [0x1FAB0, 0x1FABA],   // 🪰–🪺
  [0x1FAC0, 0x1FAC5],   // 🫀–🫅
  [0x1FAD0, 0x1FAD9],   // 🫐–🫙
  [0x1FAE0, 0x1FAE7],   // 🫠–🫧
  [0x1FAF0, 0x1FAF6],   // 🫰–🫶
  // CJK Extensions B–G+
  [0x20000, 0x3FFFF],
];

// Binary search: is codepoint in any of the sorted [start,end] ranges?
function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function isZeroWidth(cp: number): boolean {
  if (cp >= 0x200B && cp <= 0x200F) return true;  // ZWS, ZWNJ, ZWJ, LRM, RLM
  if (cp >= 0x2028 && cp <= 0x202E) return true;  // Separators, embeddings
  if (cp >= 0x2060 && cp <= 0x2069) return true;  // Word Joiner, invisibles
  if (cp === 0xFEFF || cp === 0x00AD) return true; // BOM, soft hyphen
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;  // Variation Selectors
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true; // VS Supplement
  if (cp >= 0x0300 && cp <= 0x036F) return true;  // Combining Diacriticals
  if (cp >= 0x1AB0 && cp <= 0x1AFF) return true;  // Combining Extended
  if (cp >= 0x1DC0 && cp <= 0x1DFF) return true;  // Combining Supplement
  if (cp >= 0x20D0 && cp <= 0x20FF) return true;  // Combining for Symbols
  if (cp >= 0xFE20 && cp <= 0xFE2F) return true;  // Combining Half Marks
  return false;
}

// Tag characters used in emoji tag sequences (subdivision flags like 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
function isTagChar(cp: number): boolean {
  return cp >= 0xE0020 && cp <= 0xE007F;
}

// Advance past one grapheme cluster starting at position `i` in string `s`.
// Returns [columnWidth, newIndex].
//
// Designed for COMMON terminal behavior (VTE, xterm, most Linux terminals):
//   - ZWJ sequences render as SEPARATE glyphs (not collapsed)
//   - Skin tone modifiers render as SEPARATE glyphs (not merged)
//   - VS16 does NOT promote text-presentation chars to wide
//   - Regional indicator PAIRS render as single flag glyphs  ✅
//   - Tag sequences (subdivision flags) are invisible            ✅
//   - Combining marks / variation selectors are zero-width       ✅
function nextGrapheme(s: string, i: number): [width: number, end: number] {
  const cp = s.codePointAt(i)!;
  const charLen = cp > 0xFFFF ? 2 : 1;

  // Standalone zero-width character
  if (isZeroWidth(cp)) {
    return [0, i + charLen];
  }

  // Regional Indicator: consume pairs as a single 2-col flag glyph.
  // Unpaired RIs are 1 col (wcswidth=1).
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
    let end = i + charLen;
    if (end < s.length) {
      const next = s.codePointAt(end)!;
      if (next >= 0x1F1E6 && next <= 0x1F1FF) {
        end += (next > 0xFFFF ? 2 : 1);
        return [2, end]; // paired → flag glyph, 2 cols
      }
    }
    return [1, end]; // unpaired → 1 col
  }

  // Base character width purely from WIDE_RANGES table.
  // No VS16 promotion — most terminals don't widen text-presentation chars.
  const charWidth = inRanges(cp, WIDE_RANGES) ? 2 : 1;
  let end = i + charLen;

  if (charWidth === 2) {
    // Consume VS16 after a wide char (redundant but present in many sequences)
    if (end < s.length && s.codePointAt(end) === 0xFE0F) {
      end++;
    }
    // Consume tag sequence (for subdivision flags: 🏴 + tag chars + cancel tag)
    while (end < s.length && isTagChar(s.codePointAt(end)!)) {
      end += 2; // tag chars are supplementary
    }
  }

  // Consume trailing zero-width characters (combining marks, VS16 after
  // non-wide chars, ZWJ, etc.) so they stay attached to their base when slicing.
  while (end < s.length) {
    const trail = s.codePointAt(end)!;
    if (isZeroWidth(trail)) {
      end += trail > 0xFFFF ? 2 : 1;
    } else {
      break;
    }
  }

  return [charWidth, end];
}

// Returns the terminal display width of a string (number of columns).
// Processes full grapheme clusters to correctly handle emoji sequences,
// ZWJ joins, skin tone modifiers, flag pairs, and tag sequences.
export function termWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const [cw, end] = nextGrapheme(s, i);
    w += cw;
    i = end;
  }
  return w;
}

// Slice a string so the taken portion fits within `maxCols` terminal columns.
// Returns [taken, rest].  Never splits a grapheme cluster (surrogate pair,
// emoji sequence, base+combining, flag pair, ZWJ chain, etc.).
export function sliceByWidth(s: string, maxCols: number): [string, string] {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const [cw, end] = nextGrapheme(s, i);
    if (w + cw > maxCols) break;
    w += cw;
    i = end;
  }
  return [s.slice(0, i), s.slice(i)];
}

// Strip ANSI escape sequences and return the terminal column width.
// Uses termWidth() to correctly account for double-width emoji/CJK and
// zero-width joiners/combiners/variation selectors.
export function visibleLength(s: string): number {
  return termWidth(s.replace(/\x1b\[[0-9;]*m/g, ""));
}

// --- Hard-break utility ---
// Breaks a single word that exceeds `width` into chunks, pushing full
// chunks to `result` and returning the leftover tail.
// Shared by paragraph wrapping (wordwrap.ts) and table cells (tables.ts).
export function hardBreak(word: string, width: number, result: string[]): string {
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
