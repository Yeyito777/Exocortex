import { describe, expect, test } from "bun:test";

import { renderLineWithCursor, renderLineWithSelection } from "./cursorrender";
import { handlePromptKey, getInputLines } from "./promptline";
import { createInitialState } from "./state";
import { parseInput } from "./input";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("emoji grapheme handling", () => {
  test("input parser emits emoji as one char event", () => {
    expect(parseInput("🎤")).toEqual([{ type: "char", char: "🎤" }]);
    expect(parseInput("a🎤b")).toEqual([
      { type: "char", char: "a" },
      { type: "char", char: "🎤" },
      { type: "char", char: "b" },
    ]);
  });

  test("prompt insertion, movement, and deletion never split emoji", () => {
    const state = createInitialState();

    handlePromptKey(state, { type: "char", char: "🎤" });
    expect(state.inputBuffer).toBe("🎤");
    expect(state.cursorPos).toBe("🎤".length);

    handlePromptKey(state, { type: "left" });
    expect(state.cursorPos).toBe(0);

    handlePromptKey(state, { type: "right" });
    expect(state.cursorPos).toBe("🎤".length);

    handlePromptKey(state, { type: "backspace" });
    expect(state.inputBuffer).toBe("");
    expect(state.cursorPos).toBe(0);
  });

  test("prompt wrapping does not split emoji at a narrow boundary", () => {
    const input = getInputLines("a🎤b", "a🎤b".length, 3, 10);

    expect(input.lines).toEqual(["a🎤", "b"]);
    expect(input.cursorLine).toBe(1);
    expect(input.cursorCol).toBe(1);
  });

  test("inline cursor and selection wrap the whole emoji cluster", () => {
    expect(stripAnsi(renderLineWithCursor("🎤!", 0))).toBe("🎤!");
    expect(stripAnsi(renderLineWithCursor("🎤!", 1))).toBe("🎤!");
    expect(stripAnsi(renderLineWithSelection("🎤!", 1, 1))).toBe("🎤!");
  });
});
