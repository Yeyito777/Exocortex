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

  test("distinguishes Ctrl+Shift+R from Ctrl+R", () => {
    expect(parseInput("\x1b[114;6:1u")).toEqual([
      { type: "ctrl-shift-r", event: "press" },
    ]);
    expect(parseInput("\x1b[114;5:1u")).toEqual([
      { type: "ctrl-r", event: "press" },
    ]);
  });

  test("distinguishes Ctrl+Shift+E from Ctrl+E (st's legacy and kitty forms)", () => {
    expect(parseInput("\x1b[101;6u")).toEqual([{ type: "ctrl-shift-e" }]);
    expect(parseInput("\x1b[101;6:1u")).toEqual([{ type: "ctrl-shift-e", event: "press" }]);
    expect(parseInput("\x05")).toEqual([{ type: "ctrl-e" }]);
  });

  test("treats shift+backspace like regular backspace", () => {
    expect(parseInput("\x1b[127;2u")).toEqual([{ type: "backspace", event: "press" }]);
    expect(parseInput("\x1b[127;2:2u")).toEqual([{ type: "backspace", event: "repeat" }]);
    expect(parseInput("\x1b[8;2u")).toEqual([{ type: "backspace", event: "press" }]);
  });
});

describe("kitty functional keys", () => {
  test("modifier, lock and private-use function keys produce no text", () => {
    for (const seq of [
      "\x1b[57441;2u",   // Left Shift press
      "\x1b[57441;1:3u", // Left Shift release
      "\x1b[57442;5u",   // Left Control press
      "\x1b[57358u",     // Caps Lock
      "\x1b[57376u",     // F13
      "\x1b[57428u",     // Media Play
    ]) {
      expect(parseInput(seq)).toEqual([]);
    }
  });

  test("keypad Enter submits like Enter", () => {
    expect(parseInput("\x1b[57414u")).toEqual([{ type: "enter", event: "press" }]);
    expect(parseInput("\x1b[57414;1:3u")).toEqual([{ type: "enter", event: "release" }]);
    expect(parseInput("\x1b[57414;2u")).toEqual([{ type: "shift-enter", event: "press" }]);
  });

  test("keypad keys without associated text map to their characters and motions", () => {
    expect(parseInput("\x1b[57400u")).toEqual([{ type: "char", char: "1", event: "press" }]);
    expect(parseInput("\x1b[57413u")).toEqual([{ type: "char", char: "+", event: "press" }]);
    expect(parseInput("\x1b[57417u")).toEqual([{ type: "left", event: "press" }]);
    expect(parseInput("\x1b[57426u")).toEqual([{ type: "delete", event: "press" }]);
  });

  test("keypad keys with associated text still use the text", () => {
    expect(parseInput("\x1b[57400;;49u")).toEqual([{ type: "char", char: "1", event: "press" }]);
  });
});

describe("kitty event types on legacy CSI keys", () => {
  test("repeat and release events for arrows, Home and End keep their key", () => {
    expect(parseInput("\x1b[1;1:2D")).toEqual([{ type: "left", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:2A")).toEqual([{ type: "up", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:3C")).toEqual([{ type: "right", event: "release" }]);
    expect(parseInput("\x1b[1;1:2H")).toEqual([{ type: "home", event: "repeat" }]);
    expect(parseInput("\x1b[1;1:2F")).toEqual([{ type: "end", event: "repeat" }]);
  });

  test("repeat events for ~ keys keep their key", () => {
    expect(parseInput("\x1b[3;1:2~")).toEqual([{ type: "delete", event: "repeat" }]);
    expect(parseInput("\x1b[15;2:2~")).toEqual([{ type: "f17", event: "repeat" }]);
    expect(parseInput("\x1b[1;2:1Q")).toEqual([{ type: "f14", event: "press" }]);
  });

  test("plain sequences are unchanged", () => {
    expect(parseInput("\x1b[D\x1b[3~\x1b[1;2Q\x1b[Z")).toEqual([
      { type: "left" }, { type: "delete" }, { type: "f14" }, { type: "backtab" },
    ]);
  });

  test("modified arrows stay unmapped", () => {
    expect(parseInput("\x1b[1;5D")).toEqual([]);
    expect(parseInput("\x1b[3;5~")).toEqual([]);
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
