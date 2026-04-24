import { describe, expect, test } from "bun:test";
import { markdownWordWrap } from "./wordwrap";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
});
