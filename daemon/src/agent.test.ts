import { describe, expect, test } from "bun:test";
import { buildContextPressureWarning, shouldInjectContextPressureWarning } from "./agent";

describe("buildContextPressureWarning", () => {
  test("returns null below the context pressure threshold", () => {
    expect(buildContextPressureWarning(799_999, 1_000_000)).toBeNull();
  });

  test("targets 40% of the model context window for cleanup", () => {
    const warning = buildContextPressureWarning(900_000, 1_000_000);
    expect(warning).not.toBeNull();
    expect(warning?.hint).toContain("Free at least ~500k tokens");
    expect(warning?.hint).toContain("stable 400k");
  });

  test("formats non-round dynamic targets", () => {
    const warning = buildContextPressureWarning(220_000, 272_000);
    expect(warning).not.toBeNull();
    expect(warning?.hint).toContain("Free at least ~111k tokens");
    expect(warning?.hint).toContain("stable 108.8k");
  });
});

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
