import { parseLocalFileLinkTarget as localPathFromTarget } from "@exocortex/shared/file-links";
export { localPathFromTarget };

/** Link ranges use UTF-16 offsets in ANSI-stripped display text (like history cursors). */
export interface LinkSpan {
  start: number;
  end: number;
  target: string;
}

export function isWebUrl(target: string): boolean {
  if (!/^https?:\/\//i.test(target) || /[\s\u0000-\u001f\u007f-\u009f]/u.test(target)) return false;
  try { return !!new URL(target).hostname; } catch { return false; }
}

/** Strip prose punctuation, but preserve balanced parentheses in URL paths. */
export function trimUrlPunctuation(raw: string): string {
  let target = raw.replace(/[.,;:!?]+$/g, "");
  for (;;) {
    const close = target.at(-1);
    const open = close === ")" ? "(" : close === "]" ? "[" : close === "}" ? "{" : null;
    if (!open || target.split(close!).length <= target.split(open).length) return target;
    target = target.slice(0, -1).replace(/[.,;:!?]+$/g, "");
  }
}

export interface InlineLink {
  end: number;
  labelStart: number;
  labelEnd: number;
  target: string;
}

/** Inline web/local Markdown links, plus HTTP(S) autolinks and bare URLs. */
export function inlineLinkAt(src: string, start: number, end = src.length): InlineLink | null {
  if (!/[\[<hH]/.test(src[start] ?? "")) return null;
  if (src[start] === "[" && src[start - 1] !== "!" && src[start - 1] !== "\\") {
    let depth = 1;
    let labelEnd = start + 1;
    for (; labelEnd < end; labelEnd++) {
      if (src[labelEnd] === "\\") { labelEnd++; continue; }
      if (src[labelEnd] === "[") depth++;
      if (src[labelEnd] === "]" && --depth === 0) break;
    }
    if (labelEnd > start + 1 && src.slice(labelEnd, labelEnd + 2) === "](") {
      let pos = labelEnd + 2;
      while (/\s/.test(src[pos] ?? "") && pos < end) pos++;
      const angled = src[pos] === "<";
      const targetStart = pos + (angled ? 1 : 0);
      pos = targetStart;
      let parens = 0;
      for (; pos < end; pos++) {
        const ch = src[pos];
        if (ch === "\\" && /[\\()[\] <>]/.test(src[pos + 1] ?? "")) { pos++; continue; }
        if (angled ? ch === ">" : (/\s/.test(ch) || (ch === ")" && parens === 0))) break;
        if (ch === "(") parens++;
        if (ch === ")") parens--;
      }
      const target = src.slice(targetStart, pos).replace(/\\([\\()[\] <>])/g, "$1");
      if (angled && src[pos++] !== ">") return null;
      while (/\s/.test(src[pos] ?? "") && pos < end) pos++;
      // Optional Markdown title (not part of the URL).
      if (src[pos] === '"' || src[pos] === "'") {
        const quote = src[pos++];
        while (pos < end && src[pos] !== quote) { if (src[pos] === "\\") pos++; pos++; }
        if (src[pos++] !== quote) return null;
        while (/\s/.test(src[pos] ?? "") && pos < end) pos++;
      }
      if (pos < end && src[pos] === ")" && (isWebUrl(target) || localPathFromTarget(target) !== null)) {
        return { end: pos + 1, labelStart: start + 1, labelEnd, target };
      }
    }
  }

  const angled = src[start] === "<";
  const urlStart = start + (angled ? 1 : 0);
  if (src[urlStart] !== "h" && src[urlStart] !== "H") return null;
  if (!angled && start > 0 && /[\w]/.test(src[start - 1])) return null;
  const match = src.slice(urlStart, end).match(/^https?:\/\/[^\s<>"'`\u0000-\u001f\u007f-\u009f]+/i);
  if (!match) return null;
  const target = angled ? match[0] : trimUrlPunctuation(match[0]);
  if (!isWebUrl(target)) return null;
  const labelEnd = urlStart + target.length;
  if (angled && src[labelEnd] !== ">") return null;
  return { end: labelEnd + (angled ? 1 : 0), labelStart: urlStart, labelEnd, target };
}
