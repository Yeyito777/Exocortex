import { describe, expect, test } from "bun:test";
import { parseInput, PasteBuffer } from "./input";

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

describe("PasteBuffer", () => {
  test("preserves UTF-8 characters split across stdin chunks", () => {
    const bytes = Buffer.from("\x1b[200~Eé\x1b[201~", "utf8");
    const splitAt = bytes.indexOf(0xc3) + 1; // between the two bytes of é
    const pasteBuffer = new PasteBuffer(() => {});

    expect(pasteBuffer.feed(bytes.subarray(0, splitAt))).toBeNull();
    const ready = pasteBuffer.feed(bytes.subarray(splitAt));

    expect(parseInput(ready ?? "")).toEqual([{ type: "paste", text: "Eé" }]);
  });
});
