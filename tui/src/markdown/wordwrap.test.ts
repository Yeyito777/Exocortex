import { describe, expect, test } from "bun:test";
import { markdownWordWrap } from "./wordwrap";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("markdown inline formatting across wraps", () => {
  test("keeps bold formatting when a span crosses a soft wrap", () => {
    const result = markdownWordWrap("**this should be bold**", 16, "\x1b[0m");

    expect(result.lines.map(stripAnsi)).toEqual(["this should be", "bold"]);
    expect(result.lines[0]).toContain("\x1b[1m");
    expect(result.lines[1]).toContain("\x1b[1m");
    expect(result.lines.join("\n")).not.toContain("**");
  });

  test("keeps bold formatting when a span crosses a hard newline", () => {
    const result = markdownWordWrap("**this should be bold\n**", 80, "\x1b[0m");

    expect(result.lines.map(stripAnsi)).toEqual(["this should be bold", ""]);
    expect(result.lines[0]).toContain("\x1b[1m");
    expect(result.lines.join("\n")).not.toContain("**");
  });

  test("does not treat adjacent star bullet lines as cross-line italic", () => {
    const result = markdownWordWrap("* one\n* two", 80, "\x1b[0m");

    expect(result.lines.map(stripAnsi)).toEqual(["* one", "* two"]);
    expect(result.lines.join("\n")).not.toContain("\x1b[3m");
  });

  test("keeps table cell formatting when a span crosses wrapped cell lines", () => {
    const input = [
      "| A | B |",
      "|---|---|",
      "| **this should be bold** | ok |",
    ].join("\n");

    const result = markdownWordWrap(input, 25, "\x1b[0m");

    expect(result.lines.map(stripAnsi)).toEqual([
      "┌─────────────────┬─────┐",
      "│ A               │ B   │",
      "├─────────────────┼─────┤",
      "│ this should     │ ok  │",
      "│ be bold         │     │",
      "└─────────────────┴─────┘",
    ]);
    expect(result.lines[3]).toContain("\x1b[1m");
    expect(result.lines[4]).toContain("\x1b[1m");
    expect(result.lines.join("\n")).not.toContain("**");
    const widths = result.lines.map(line => stripAnsi(line).length);
    expect(widths.every(width => width === widths[0])).toBe(true);
  });
});

describe("markdown fenced code block wrapping", () => {
  test("renders fenced code blocks nested under list items", () => {
    const input = [
      "3. **Build a local CLI tool**",
      "   - Probably at:",
      "     ```bash",
      "     ~/Workspace/Exocortex/external-tools/router-cli",
      "     ```",
      "   - Exposed as:",
      "     ```bash",
      "     router",
      "     ```",
    ].join("\n");

    const rendered = markdownWordWrap(input, 80, "\x1b[0m").lines.map(stripAnsi);

    expect(rendered).toEqual([
      "3. Build a local CLI tool",
      "- Probably at:",
      "▎ bash",
      "▎ ~/Workspace/Exocortex/external-tools/router-cli",
      "- Exposed as:",
      "▎ bash",
      "▎ router",
    ]);
  });

  test("marks hard-wrapped code lines as continuations", () => {
    const path = "/home/yeyito/Workspace/research/teto-tts/teto-tts-v3/outputs/teto_normal_kasane_teto_teto_dayo.wav";
    const result = markdownWordWrap(["```text", path, "```"].join("\n"), 60, "\x1b[0m");

    expect(result.lines.map(stripAnsi)).toEqual([
      "▎ text",
      "▎ /home/yeyito/Workspace/research/teto-tts/teto-tts-v3/outpu",
      "▎ ts/teto_normal_kasane_teto_teto_dayo.wav",
    ]);
    expect(result.cont).toEqual([false, false, true]);
    expect(result.join).toEqual(["", "", ""]);
  });
});
