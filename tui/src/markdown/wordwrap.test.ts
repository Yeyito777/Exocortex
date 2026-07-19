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

describe("markdown math rendering", () => {
  test("renders inline math inside prose and tables", () => {
    const prose = markdownWordWrap(String.raw`For \(P\land Q\), use **both** statements.`, 80, "\x1b[0m");
    expect(prose.lines.map(stripAnsi)).toEqual(["For P ∧ Q, use both statements."]);
    expect(prose.lines.join("\n")).toContain("\x1b[1m");

    const table = markdownWordWrap([
      String.raw`| \(P\) | \(\neg P\) |`,
      "|---|---|",
      "| T | F |",
    ].join("\n"), 30, "\x1b[0m");
    expect(table.lines.map(stripAnsi)).toEqual([
      "┌───┬─────┐",
      "│ P │ ¬ P │",
      "├───┼─────┤",
      "│ T │ F   │",
      "└───┴─────┘",
    ]);
  });

  test("renders standalone display math and retains Unicode copy projection", () => {
    const rendered = markdownWordWrap([
      String.raw`\[`,
      String.raw`\neg(P\land Q)\iff(\neg P\lor\neg Q)`,
      String.raw`\]`,
    ].join("\n"), 60, "\x1b[0m");

    expect(rendered.lines.map(line => stripAnsi(line).trim())).toEqual([
      "¬(P ∧ Q) ⇔ (¬ P ∨ ¬ Q)",
    ]);
    expect(rendered.copy?.[0]?.text).toBe("¬(P ∧ Q) ⇔ (¬ P ∨ ¬ Q)");
  });

  test("treats pretty-printed display source as one expression", () => {
    const rendered = markdownWordWrap([
      String.raw`\[`,
      String.raw`\forall x\exists y\Big(`,
      String.raw`(y\times y\times y=x)`,
      String.raw`\land`,
      String.raw`\forall z\big((z\times z\times z=x)\Rightarrow(z=y)\big)`,
      String.raw`\Big).`,
      String.raw`\]`,
    ].join("\n"), 100, "\x1b[0m");

    expect(rendered.lines.map(stripAnsi)).toEqual([
      "∀ x∃ y((y × y × y=x) ∧ ∀ z((z × z × z=x) ⇒ (z=y))).",
    ]);
  });

  test("does not render math delimiters inside fenced or inline code", () => {
    const rendered = markdownWordWrap([
      String.raw`Inline \(x^2\), but ` + "`" + String.raw`\(x^2\)` + "`.",
      "```text",
      String.raw`\[x^2\]`,
      "```",
    ].join("\n"), 80, "\x1b[0m");

    expect(rendered.lines.map(stripAnsi)).toEqual([
      "Inline x², but \\(x^2\\).",
      "▎ text",
      "▎ \\[x^2\\]",
    ]);
  });

  test("does not render math inside an inline code span crossing a hard newline", () => {
    const rendered = markdownWordWrap([
      "Code `literal \\(x^2\\)",
      "continues here`, then \\(y^2\\).",
    ].join("\n"), 80, "\x1b[0m");

    expect(rendered.lines.map(stripAnsi)).toEqual([
      "Code literal \\(x^2\\)",
      "continues here, then y².",
    ]);
  });
});
