import { describe, expect, test } from "bun:test";
import { splitTopLevelShellSegments } from "./bashsegments";

describe("splitTopLevelShellSegments", () => {
  test("splits on top-level shell control operators", () => {
    expect(splitTopLevelShellSegments("echo hi && gmail search \"from:alice\" --limit 5; false || whatsapp messages Mom -n 5"))
      .toEqual([
        { text: "echo hi ", start: 0, separator: "&&" },
        { text: ' gmail search "from:alice" --limit 5', start: 10, separator: ";" },
        { text: " false ", start: 47, separator: "||" },
        { text: " whatsapp messages Mom -n 5", start: 56, separator: "" },
      ]);
  });

  test("splits single pipelines at top level", () => {
    expect(splitTopLevelShellSegments("cat /tmp/prompt.txt | exo llm -- --model openai/gpt-5.4 | sed -n '1,5p'"))
      .toEqual([
        { text: "cat /tmp/prompt.txt ", start: 0, separator: "|" },
        { text: " exo llm -- --model openai/gpt-5.4 ", start: 21, separator: "|" },
        { text: " sed -n '1,5p'", start: 57, separator: "" },
      ]);
  });

  test("does not split separators inside quotes", () => {
    expect(splitTopLevelShellSegments("echo \"a && b\" && printf 'x || y; z'"))
      .toEqual([
        { text: 'echo "a && b" ', start: 0, separator: "&&" },
        { text: " printf 'x || y; z'", start: 16, separator: "" },
      ]);
  });
});
