/**
 * Terminal-width utilities shared across the TUI.
 *
 * These helpers count terminal columns rather than UTF-16 code units, so UI
 * chrome can safely truncate and pad strings containing emoji, CJK, combining
 * marks, and other wide / zero-width glyphs.
 */

// Sorted ranges of always-double-width codepoints [start, end] (inclusive).
// Generated from glibc 2.43 wcwidth (Unicode 17), which st uses: East Asian
// Width W/F + Emoji_Presentation=Yes. Code points glibc leaves unassigned keep
// their previous width; zero-width ones (checked first) may bridge ranges.
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115F],
  [0x231A, 0x231B],
  [0x2329, 0x232A],
  [0x23E9, 0x23EC],
  [0x23F0, 0x23F0],
  [0x23F3, 0x23F3],
  [0x25FD, 0x25FE],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267F, 0x267F],
  [0x268A, 0x268F],
  [0x2693, 0x2693],
  [0x26A1, 0x26A1],
  [0x26AA, 0x26AB],
  [0x26BD, 0x26BE],
  [0x26C4, 0x26C5],
  [0x26CE, 0x26CE],
  [0x26D4, 0x26D4],
  [0x26EA, 0x26EA],
  [0x26F2, 0x26F3],
  [0x26F5, 0x26F5],
  [0x26FA, 0x26FA],
  [0x26FD, 0x26FD],
  [0x2705, 0x2705],
  [0x270A, 0x270B],
  [0x2728, 0x2728],
  [0x274C, 0x274C],
  [0x274E, 0x274E],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27B0, 0x27B0],
  [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C],
  [0x2B50, 0x2B50],
  [0x2B55, 0x2B55],
  [0x2E80, 0x303E],
  [0x3040, 0xA4CF],
  [0xA960, 0xA97C],
  [0xAC00, 0xD7AF],
  [0xF900, 0xFAFF],
  [0xFE10, 0xFE19],
  [0xFE30, 0xFE6F],
  [0xFF01, 0xFF60],
  [0xFFE0, 0xFFE6],
  [0x16FE0, 0x16FE3],
  [0x16FF0, 0x16FF6],
  [0x17000, 0x18CD5],
  [0x18CFF, 0x18D1E],
  [0x18D80, 0x18DF2],
  [0x1AFF0, 0x1AFF3],
  [0x1AFF5, 0x1AFFB],
  [0x1AFFD, 0x1AFFE],
  [0x1B000, 0x1B122],
  [0x1B132, 0x1B132],
  [0x1B150, 0x1B152],
  [0x1B155, 0x1B155],
  [0x1B164, 0x1B167],
  [0x1B170, 0x1B2FB],
  [0x1D300, 0x1D356],
  [0x1D360, 0x1D376],
  [0x1F004, 0x1F004],
  [0x1F0CF, 0x1F0CF],
  [0x1F18E, 0x1F18E],
  [0x1F191, 0x1F19A],
  [0x1F200, 0x1F202],
  [0x1F210, 0x1F23B],
  [0x1F240, 0x1F248],
  [0x1F250, 0x1F251],
  [0x1F260, 0x1F265],
  [0x1F300, 0x1F320],
  [0x1F32D, 0x1F335],
  [0x1F337, 0x1F37C],
  [0x1F37E, 0x1F393],
  [0x1F3A0, 0x1F3CA],
  [0x1F3CF, 0x1F3D3],
  [0x1F3E0, 0x1F3F0],
  [0x1F3F4, 0x1F3F4],
  [0x1F3F8, 0x1F43E],
  [0x1F440, 0x1F440],
  [0x1F442, 0x1F4FC],
  [0x1F4FF, 0x1F53D],
  [0x1F54B, 0x1F54E],
  [0x1F550, 0x1F567],
  [0x1F57A, 0x1F57A],
  [0x1F595, 0x1F596],
  [0x1F5A4, 0x1F5A4],
  [0x1F5FB, 0x1F64F],
  [0x1F680, 0x1F6C5],
  [0x1F6CC, 0x1F6CC],
  [0x1F6D0, 0x1F6D2],
  [0x1F6D5, 0x1F6D8],
  [0x1F6DC, 0x1F6DF],
  [0x1F6EB, 0x1F6EC],
  [0x1F6F4, 0x1F6FC],
  [0x1F7E0, 0x1F7EB],
  [0x1F7F0, 0x1F7F0],
  [0x1F90C, 0x1F93A],
  [0x1F93C, 0x1F945],
  [0x1F947, 0x1F9FF],
  [0x1FA70, 0x1FA7C],
  [0x1FA80, 0x1FA8A],
  [0x1FA8E, 0x1FAC6],
  [0x1FAC8, 0x1FAC8],
  [0x1FACD, 0x1FADC],
  [0x1FADF, 0x1FAEA],
  [0x1FAEF, 0x1FAF8],
  [0x20000, 0x3FFFF],
];

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const UNICODE_NONSPACING_OR_ENCLOSING_MARK_RE = /[\p{Mn}\p{Me}]/u;

function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function isZeroWidth(cp: number): boolean {
  // Keep this property check first so script-specific combining marks outside
  // the common ranges below (for example U+0A48 GURMUKHI VOWEL SIGN AI) don't
  // consume a terminal column and push sidebar borders out of alignment.
  if (UNICODE_NONSPACING_OR_ENCLOSING_MARK_RE.test(String.fromCodePoint(cp))) return true;
  if (cp >= 0x200B && cp <= 0x200F) return true;
  if (cp >= 0x2028 && cp <= 0x202E) return true;
  if (cp >= 0x2060 && cp <= 0x206F) return true;
  if (cp === 0xFEFF || cp === 0x061C || cp === 0x180E) return true;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
  // Hangul conjoining vowels and finals (they join the preceding initial) and fillers.
  if ((cp >= 0x1160 && cp <= 0x11FF) || (cp >= 0xD7B0 && cp <= 0xD7FF)) return true;
  if (cp === 0x3164 || cp === 0xFFA0) return true;
  if ((cp >= 0x1BCA0 && cp <= 0x1BCA3) || (cp >= 0x1D173 && cp <= 0x1D17A)) return true;
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
  if (cp >= 0x0300 && cp <= 0x036F) return true;
  if (cp >= 0x1AB0 && cp <= 0x1AFF) return true;
  if (cp >= 0x1DC0 && cp <= 0x1DFF) return true;
  if (cp >= 0x20D0 && cp <= 0x20FF) return true;
  if (cp >= 0xFE20 && cp <= 0xFE2F) return true;
  return false;
}

function isTagChar(cp: number): boolean {
  return cp >= 0xE0020 && cp <= 0xE007F;
}

export function nextGrapheme(s: string, i: number): [width: number, end: number] {
  const cp = s.codePointAt(i)!;
  const charLen = cp > 0xFFFF ? 2 : 1;

  if (isZeroWidth(cp)) {
    return [0, i + charLen];
  }

  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
    let end = i + charLen;
    if (end < s.length) {
      const next = s.codePointAt(end)!;
      if (next >= 0x1F1E6 && next <= 0x1F1FF) {
        end += next > 0xFFFF ? 2 : 1;
        return [2, end];
      }
    }
    return [1, end];
  }

  const charWidth = inRanges(cp, WIDE_RANGES) ? 2 : 1;
  let end = i + charLen;

  if (charWidth === 2) {
    if (end < s.length && s.codePointAt(end) === 0xFE0F) {
      end++;
    }
    while (end < s.length && isTagChar(s.codePointAt(end)!)) {
      end += 2;
    }
  }

  while (end < s.length) {
    const trail = s.codePointAt(end)!;
    if (!isZeroWidth(trail)) break;
    end += trail > 0xFFFF ? 2 : 1;
  }

  return [charWidth, end];
}

export function termWidth(s: string): number {
  let asciiWidth = 0;
  while (asciiWidth < s.length) {
    const code = s.charCodeAt(asciiWidth);
    if (code < 0x20 || code > 0x7E) break;
    asciiWidth++;
  }
  if (asciiWidth === s.length) return asciiWidth;

  let w = asciiWidth;
  let i = asciiWidth;
  while (i < s.length) {
    const [cw, end] = nextGrapheme(s, i);
    w += cw;
    i = end;
  }
  return w;
}

export function sliceByWidthFrom(s: string, start: number, maxCols: number): [end: number, width: number] {
  let w = 0;
  let i = Math.max(0, Math.min(start, s.length));
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7E) {
      if (w + 1 > maxCols) break;
      w++;
      i++;
      continue;
    }

    const [cw, end] = nextGrapheme(s, i);
    if (w + cw > maxCols) break;
    w += cw;
    i = end;
  }
  return [i, w];
}

export function sliceByWidth(s: string, maxCols: number): [string, string] {
  const [i] = sliceByWidthFrom(s, 0, maxCols);
  return [s.slice(0, i), s.slice(i)];
}

export function visibleLength(s: string): number {
  return termWidth(s.replace(ANSI_ESCAPE_RE, ""));
}

export function hardBreak(word: string, width: number, result: string[]): string {
  let start = 0;
  for (;;) {
    const [end] = sliceByWidthFrom(word, start, width);
    if (end >= word.length) return word.slice(start);
    if (end === start) {
      const cp = word.codePointAt(start)!;
      const next = start + (cp > 0xFFFF ? 2 : 1);
      result.push(word.slice(start, next));
      start = next;
    } else {
      result.push(word.slice(start, end));
      start = end;
    }
  }
}

export function truncateToWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  const [fitEnd] = sliceByWidthFrom(text, 0, maxCols);
  if (fitEnd >= text.length) return text;
  if (maxCols === 1) return "…";
  const [takenEnd] = sliceByWidthFrom(text, 0, maxCols - 1);
  return text.slice(0, takenEnd) + "…";
}

export function padRightToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  const padding = Math.max(0, width - termWidth(truncated));
  return truncated + " ".repeat(padding);
}

export function padVisibleRightToWidth(text: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(text));
  return text + " ".repeat(padding);
}

export function getViewportByWidth(
  text: string,
  cursorIndex: number,
  maxCols: number,
): { visibleText: string; cursorCol: number; startIndex: number } {
  const safeMax = Math.max(0, maxCols);
  const safeCursor = Math.max(0, Math.min(cursorIndex, text.length));
  if (safeMax === 0) {
    return { visibleText: "", cursorCol: 0, startIndex: safeCursor };
  }

  let startIndex = 0;
  while (startIndex < safeCursor && termWidth(text.slice(startIndex, safeCursor)) > safeMax) {
    startIndex = nextGrapheme(text, startIndex)[1];
  }

  const [visibleText] = sliceByWidth(text.slice(startIndex), safeMax);
  const cursorCol = Math.min(safeMax, termWidth(text.slice(startIndex, safeCursor)));

  return { visibleText, cursorCol, startIndex };
}
