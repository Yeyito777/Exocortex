import { describe, expect, test } from "bun:test";
import { spillAndPreviewForTest } from "./bash";

function makeLargeOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(`line ${i.toString().padStart(4, "0")} ${"x".repeat(80)}`);
  }
  return lines.join("\n");
}

describe("bash spill preview", () => {
  test("includes spill path instructions when temp write succeeds", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const output = spillAndPreviewForTest(makeLargeOutput(), false, (path, contents) => {
      written.push({ path, contents });
    });

    expect(written).toHaveLength(1);
    expect(output).toContain("Full output: ");
    expect(output).toContain("Use the read tool with offset/limit to browse.");
    expect(output).toContain("lines omitted");
  });

  test("degrades gracefully when temp write fails", () => {
    const output = spillAndPreviewForTest(makeLargeOutput(), true, () => {
      throw new Error("EDQUOT: quota exceeded");
    });

    expect(output).toContain("Full output could not be written to a temp file");
    expect(output).toContain("EDQUOT: quota exceeded");
    expect(output).toContain("byte-truncated at 1MB");
    expect(output).not.toContain("Use the read tool with offset/limit to browse.");
  });
});
