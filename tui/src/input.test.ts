import { describe, expect, test } from "bun:test";
import { parseInput } from "./input";

describe("kitty keyboard protocol parsing", () => {
  test("parses event types for all-keys CSI u input", () => {
    expect(parseInput("\x1b[32;1:3;32u")).toEqual([
      { type: "char", char: " ", event: "release" },
    ]);
    expect(parseInput("\x1b[97;1:2;97u")).toEqual([
      { type: "char", char: "a", event: "repeat" },
    ]);
  });

  test("keeps legacy CSI u mappings working", () => {
    expect(parseInput("\x1b[13u")).toEqual([{ type: "enter" }]);
  });
});
