import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { handlePromptKey } from "./promptline";
import { createInitialState } from "./state";

describe("prompt curswant", () => {
  test("insert-mode up/down preserve preferred column across short lines", () => {
    const state = createInitialState();
    state.inputBuffer = "abcdef\nx\n123456789";
    state.cursorPos = 5;

    expect(handlePromptKey(state, { type: "down" })).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(8); // end of the short middle line

    expect(handlePromptKey(state, { type: "down" })).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(14); // third line, original column 5
    expect(state.promptCurswant).toBe(5);
  });

  test("horizontal prompt motion resets the preferred column", () => {
    const state = createInitialState();
    state.inputBuffer = "abcdef\nx\n123456789";
    state.cursorPos = 5;

    handlePromptKey(state, { type: "down" });
    handlePromptKey(state, { type: "down" });
    expect(state.cursorPos).toBe(14);

    handlePromptKey(state, { type: "left" });
    expect(state.cursorPos).toBe(13);
    expect(state.promptCurswant).toBeNull();

    handlePromptKey(state, { type: "up" });
    expect(state.cursorPos).toBe(8);
    handlePromptKey(state, { type: "down" });
    expect(state.cursorPos).toBe(13); // new column 4, not stale column 5
  });

  test("normal-mode j/k preserve preferred column in the prompt", () => {
    const state = createInitialState();
    state.inputBuffer = "abcdef\nx\n123456789";
    state.cursorPos = 5;
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(7); // on the short line's last char, not past it

    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(14);
  });

  test("normal-mode j/k do not land past the last character of a prompt line", () => {
    const state = createInitialState();
    state.inputBuffer = "abcdef\nx\n123456789";
    state.cursorPos = 5;
    state.vim.mode = "normal";

    handleFocusedKey({ type: "char", char: "j" }, state);
    expect(state.inputBuffer[state.cursorPos]).toBe("x");
    expect(state.inputBuffer[state.cursorPos + 1]).toBe("\n");
  });

  test("normal-mode h/l do not treat newline delimiters as prompt characters", () => {
    const state = createInitialState();
    state.inputBuffer = "ab\ncd";
    state.vim.mode = "normal";

    state.cursorPos = 1; // b, last character before the newline
    expect(handleFocusedKey({ type: "char", char: "l" }, state)).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(1);
    expect(state.inputBuffer[state.cursorPos]).toBe("b");

    state.cursorPos = 3; // c, first character after the newline
    expect(handleFocusedKey({ type: "char", char: "h" }, state)).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(3);
    expect(state.inputBuffer[state.cursorPos]).toBe("c");
  });
});
