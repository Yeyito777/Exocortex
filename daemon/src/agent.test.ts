import { describe, expect, test } from "bun:test";
import { shouldInjectContextPressureWarning } from "./agent";

describe("shouldInjectContextPressureWarning", () => {
  test("returns true when the round does not use the context tool", () => {
    expect(shouldInjectContextPressureWarning([
      { id: "tool-1", name: "bash", input: { command: "pwd" } },
      { id: "tool-2", name: "read", input: { file_path: "/tmp/x" } },
    ])).toBe(true);
  });

  test("returns false when the round includes the context tool", () => {
    expect(shouldInjectContextPressureWarning([
      { id: "tool-1", name: "context", input: { action: "list" } },
    ])).toBe(false);
  });

  test("returns false when context appears alongside other tools", () => {
    expect(shouldInjectContextPressureWarning([
      { id: "tool-1", name: "bash", input: { command: "pwd" } },
      { id: "tool-2", name: "context", input: { action: "strip_thinking", start: 0, end: 5 } },
    ])).toBe(false);
  });
});
