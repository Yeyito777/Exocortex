import { describe, expect, test } from "bun:test";
import { renderAdaptiveUserMessageRows, renderUserMessage } from "./blockrenderer";
import { theme } from "./theme";
import { termWidth } from "./textwidth";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function userBubbleWidth(line: string): number {
  const backgroundStart = line.indexOf(theme.userBg);
  expect(backgroundStart).toBeGreaterThanOrEqual(0);
  const contentStart = backgroundStart + theme.userBg.length;
  const backgroundEnd = line.indexOf(theme.reset, contentStart);
  expect(backgroundEnd).toBeGreaterThanOrEqual(contentStart);
  return termWidth(stripAnsi(line.slice(contentStart, backgroundEnd)));
}

describe("adaptive user message rendering", () => {
  test("sizes a partially visible bubble from the longest line in the complete message", () => {
    const cols = 80;
    const text = "this wider line has already scrolled outside the viewport\nshort";
    const fullMessage = renderUserMessage(text, cols);
    const visibleRows = renderAdaptiveUserMessageRows(
      text,
      { lineIndex: 1, offset: 0 },
      { lineIndex: 2, offset: 0 },
      () => cols,
    );

    expect(visibleRows).toHaveLength(1);
    expect(userBubbleWidth(visibleRows[0].line)).toBe(userBubbleWidth(fullMessage.lines[0]));
  });
});
