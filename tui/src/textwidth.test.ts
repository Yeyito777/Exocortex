import { describe, expect, test } from "bun:test";

import {
  getViewportByWidth,
  padRightToWidth,
  termWidth,
  truncateToWidth,
  visibleLength,
} from "./textwidth";

describe("textwidth", () => {
  test("measures terminal columns for wide unicode", () => {
    expect(termWidth("memes＆media")).toBe(12);
    expect(termWidth("【the🦋chat】")).toBe(13);
  });

  test("treats Unicode nonspacing marks outside common ranges as zero-width", () => {
    // U+0A48 GURMUKHI VOWEL SIGN AI is Mn. It regressed in sidebar names by
    // being counted as a visible column even though terminals render it as a
    // combining mark.
    expect(termWidth("ღ jättebög ੈ✩‧₊˚")).toBe(15);
    expect(termWidth("ੈ")).toBe(0);
  });

  test("truncates by terminal width instead of utf-16 length", () => {
    expect(truncateToWidth("【the🦋chat】", 8)).toBe("【the🦋…");
  });

  test("pads plain and ANSI text to exact display width", () => {
    expect(termWidth(padRightToWidth("memes＆media", 14))).toBe(14);
    expect(visibleLength("\x1b[31m🦋\x1b[0m ")).toBe(3);
  });

  test("builds a viewport that keeps the cursor visible by terminal width", () => {
    const viewport = getViewportByWidth("ab🦋cd", "ab🦋cd".length, 4);

    expect(viewport.visibleText).toBe("🦋cd");
    expect(viewport.cursorCol).toBe(4);
  });

  test("matches glibc wcwidth (what st uses) for newer wide and zero-width code points", () => {
    // Emoji and symbols from Unicode 13-17, trigrams, enclosed ideographs.
    for (const glyph of ["🩷", "🩵", "🫨", "🛜", "🪭", "🫟", "☰", "⚊", "🈀", "🈐", "🉠", "ꥠ", "𖿠", "𛀀", "𝌀"]) {
      expect(termWidth(glyph)).toBe(2);
    }
    expect(termWidth("\u303F")).toBe(1); // ideographic half fill space
    expect(termWidth("\u00AD")).toBe(1); // soft hyphen
    // Hangul conjoining vowels/finals and fillers, format controls.
    for (const glyph of ["\u1160", "\u11FF", "\uD7B0", "\u3164", "\uFFA0", "\u061C", "\u180E", "\u206A", "\u{1BCA0}", "\u{1D173}"]) {
      expect(termWidth(glyph)).toBe(0);
    }
    expect(termWidth("\u1100\u1161\u11A8")).toBe(2); // conjoining jamo syllable
  });

  test("keeps the base width for a narrow base with an emoji presentation selector", () => {
    // Terminals disagree here (st follows wcwidth: 1); left as is deliberately.
    expect(termWidth("⚠️")).toBe(1);
    expect(termWidth("❤️")).toBe(1);
  });
});

