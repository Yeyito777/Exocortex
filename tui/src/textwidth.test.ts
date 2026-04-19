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
});
