import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { getInputLines } from "./promptline";
import { createInitialState, type RenderState } from "./state";
import { processKey } from "./vim/engine";

function prompt(buffer = "", cursor = buffer.length, mode: "insert" | "normal" = "insert"): RenderState {
  const state = createInitialState();
  state.inputBuffer = buffer;
  state.cursorPos = cursor;
  state.vim.mode = mode;
  return state;
}

function chars(state: RenderState, keys: string): void {
  for (const char of keys) handleFocusedKey({ type: "char", char }, state);
}

describe("prompt soft tabs", () => {
  test("Tab inserts four spaces and clears the preferred column", () => {
    const state = prompt();
    state.promptCurswant = 10;
    handleFocusedKey({ type: "tab" }, state);
    expect(state.inputBuffer).toBe("    ");
    expect(state.cursorPos).toBe(4);
    expect(state.promptCurswant).toBeNull();
    expect(state.autocomplete).toBeNull();
    expect(getInputLines(state.inputBuffer, state.cursorPos, 80, 5).cursorCol).toBe(4);
  });

  test("tabs insert mid-line and repeated Backspace removes one tab per press", () => {
    const state = prompt("🙂tail", 2);
    handleFocusedKey({ type: "tab" }, state);
    handleFocusedKey({ type: "tab" }, state);
    expect(state.inputBuffer).toBe("🙂        tail");
    expect(state.cursorPos).toBe(10);
    handleFocusedKey({ type: "backspace" }, state);
    expect(state.inputBuffer).toBe("🙂    tail");
    expect(state.cursorPos).toBe(6);
    handleFocusedKey({ type: "backspace" }, state);
    expect(state.inputBuffer).toBe("🙂tail");
    expect(state.cursorPos).toBe(2);
  });

  test("Delete removes one four-space tab at the cursor", () => {
    const state = prompt("a    b", 1);
    handleFocusedKey({ type: "delete" }, state);
    expect(state.inputBuffer).toBe("ab");
    expect(state.cursorPos).toBe(1);
  });

  for (const buffer of ["a b", "a  b", "a   b", "a  \n  b"]) {
    test(`short space runs still delete one character: ${JSON.stringify(buffer)}`, () => {
      const state = prompt(buffer, buffer.length - 1);
      handleFocusedKey({ type: "backspace" }, state);
      expect(state.inputBuffer).toBe(buffer.slice(0, -2) + "b");
      expect(state.cursorPos).toBe(buffer.length - 2);
    });
  }

  test("deletion does not split combining characters on spaces", () => {
    const state = prompt("    \u0301x", 0);
    handleFocusedKey({ type: "delete" }, state);
    expect(state.inputBuffer).toBe("   \u0301x");
    state.cursorPos = 4;
    handleFocusedKey({ type: "backspace" }, state);
    expect(state.inputBuffer).toBe("  x");
  });

  test("a visible command popup keeps Tab completion", () => {
    const state = prompt();
    chars(state, "/mod");
    expect(state.autocomplete).not.toBeNull();
    handleFocusedKey({ type: "tab" }, state);
    expect(state.inputBuffer).toBe("/model");
    expect(state.autocomplete?.selection).toBe(0);
  });

  test("path completion takes precedence, but no matches falls back to a tab", () => {
    const state = prompt("./example");
    const provider = {
      getFilesystemMatches: () => [{ name: "./example.ts", desc: "File" }],
      requestFilesystemMatches: () => {},
    };
    handleFocusedKey({ type: "tab" }, state, undefined, provider);
    expect(state.inputBuffer).toBe("./example.ts");
    provider.getFilesystemMatches = () => [];
    handleFocusedKey({ type: "tab" }, state, undefined, provider);
    expect(state.inputBuffer).toBe("./example.ts    ");
  });

  test("Tab in normal mode does not insert whitespace", () => {
    const state = prompt("text", 0, "normal");
    handleFocusedKey({ type: "tab" }, state);
    expect(state.inputBuffer).toBe("text");
  });

  test("tabs participate in insert-session undo and redo", () => {
    const state = prompt("text", 0, "normal");
    chars(state, "i");
    handleFocusedKey({ type: "tab" }, state);
    handleFocusedKey({ type: "escape" }, state);
    chars(state, "u");
    expect(state.inputBuffer).toBe("text");
    handleFocusedKey({ type: "ctrl-r" }, state);
    expect(state.inputBuffer).toBe("    text");
  });
});

describe("prompt line shifts", () => {
  test("first > is pending; >> shifts only the current logical line", () => {
    const state = prompt("one\ntwo\nthree", 5, "normal");
    state.promptCurswant = 8;
    chars(state, ">");
    expect(state.vim.pendingKeys).toBe(">");
    expect(state.inputBuffer).toBe("one\ntwo\nthree");
    chars(state, ">");
    expect(state.inputBuffer).toBe("one\n    two\nthree");
    expect(state.cursorPos).toBe(8);
    expect(state.vim.pendingKeys).toBe("");
    expect(state.promptCurswant).toBeNull();
    chars(state, "<<");
    expect(state.inputBuffer).toBe("one\ntwo\nthree");
    expect(state.cursorPos).toBe(4);
  });

  test("a count shifts that many lines once, not multiple indentation levels", () => {
    const state = prompt("a\nb\nc\nd", 0, "normal");
    chars(state, "3>>");
    expect(state.inputBuffer).toBe("    a\n    b\n    c\nd");
    expect(state.vim.count).toBeNull();
    chars(state, "9<<");
    expect(state.inputBuffer).toBe("a\nb\nc\nd");
  });

  test("<< removes up to four leading spaces without touching text", () => {
    const state = prompt("  a\n      b\nc", 0, "normal");
    chars(state, "3<<");
    expect(state.inputBuffer).toBe("a\n  b\nc");
    chars(state, "u");
    expect(state.inputBuffer).toBe("  a\n      b\nc");
    handleFocusedKey({ type: "ctrl-r" }, state);
    expect(state.inputBuffer).toBe("a\n  b\nc");
  });

  test("a no-op outdent does not create an undo entry", () => {
    const state = prompt("abc", 2, "normal");
    chars(state, "<<");
    expect(state.inputBuffer).toBe("abc");
    expect(state.cursorPos).toBe(0);
    expect(state.undo.undoStack).toHaveLength(0);
  });

  test("empty and trailing lines can be shifted", () => {
    const state = prompt("", 0, "normal");
    chars(state, ">>");
    expect(state.inputBuffer).toBe("    ");
    chars(state, "<<");
    expect(state.inputBuffer).toBe("");
    state.inputBuffer = "a\n";
    state.cursorPos = 2;
    chars(state, ">>");
    expect(state.inputBuffer).toBe("a\n    ");
  });

  for (const mode of ["visual", "visual-line"] as const) {
    for (const reversed of [false, true]) {
      test(`${mode} ${reversed ? "backward" : "forward"} selection shifts whole touched lines`, () => {
        const state = prompt("one\ntwo\nthree", reversed ? 1 : 5, "normal");
        state.vim.mode = mode;
        state.vim.visualAnchor = reversed ? 5 : 1;
        chars(state, ">");
        expect(state.vim.pendingKeys).toBe(">");
        expect(state.vim.mode).toBe(mode);
        chars(state, ">");
        expect(state.inputBuffer).toBe("    one\n    two\nthree");
        expect(state.cursorPos).toBe(4);
        expect(state.vim).toMatchObject({ mode: "normal" });
        chars(state, "u");
        expect(state.inputBuffer).toBe("one\ntwo\nthree");

        state.inputBuffer = "    one\n  two\nthree";
        state.cursorPos = 11;
        state.vim.mode = mode;
        state.vim.visualAnchor = 4;
        chars(state, "<<");
        expect(state.inputBuffer).toBe("one\ntwo\nthree");
        expect(state.vim).toMatchObject({ mode: "normal" });
      });
    }
  }

  test("visual-line shift never accidentally includes the following line", () => {
    const state = prompt("one\ntwo\nthree", 5, "normal");
    state.vim.mode = "visual-line";
    state.vim.visualAnchor = 4;
    chars(state, ">>");
    expect(state.inputBuffer).toBe("one\n    two\nthree");
  });

  for (const mode of ["normal", "visual", "visual-line"] as const) {
    test(`${mode} shift prefix can be cancelled with Escape or an invalid key`, () => {
      const state = prompt("one", 0, "normal");
      state.vim.mode = mode;
      chars(state, ">r");
      expect(state.vim.pendingKeys).toBe("");
      expect(state.vim.pendingReplace).toBe(false);
      expect(state.inputBuffer).toBe("one");
      chars(state, "<");
      handleFocusedKey({ type: "escape" }, state);
      expect(state.vim.pendingKeys).toBe("");
      expect(state.vim.mode).toBe("normal");
      expect(state.inputBuffer).toBe("one");
    });
  }

  test("insert mode types angle brackets instead of shifting", () => {
    const state = prompt();
    chars(state, ">><<");
    expect(state.inputBuffer).toBe(">><<");
  });

  for (const context of ["history", "sidebar"] as const) {
    test(`shift bindings cannot edit the prompt from ${context}`, () => {
      const state = prompt("text", 0, "normal");
      const first = processKey({ type: "char", char: ">" }, state.vim, context, state.inputBuffer, 0);
      expect(first.type).toBe("passthrough");
      expect(state.vim.pendingKeys).toBe("");
      const result = processKey({ type: "char", char: ">" }, state.vim, context, state.inputBuffer, 0);
      expect(result.type).not.toBe("buffer_edit");
      expect(state.vim.pendingKeys).toBe("");
    });
  }
});
