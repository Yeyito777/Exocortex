import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import type { KeyEvent } from "./input";
import { getInputLines, promptInputWidth } from "./promptline";
import { createInitialState, type RenderState } from "./state";
import { isLinewiseClipboardText, pasteFromClipboard, setTextClipboardSystemForTest } from "./vim/clipboard";
import type { VimMode } from "./vim";

/** A prompt whose wrap width is exactly `width` columns. */
function prompt(buffer: string, cursor: number, mode: VimMode = "normal", width = 76): RenderState {
  const state = createInitialState();
  state.sidebar.open = false;
  state.cols = width + 4;
  state.inputBuffer = buffer;
  state.cursorPos = cursor;
  state.vim.mode = mode;
  expect(promptInputWidth(state)).toBe(width);
  return state;
}

/** Type keys; `<esc>`, `<up>`, `<down>`, `<left>`, `<right>`, `<home>`, `<end>` are special. */
function keys(state: RenderState, sequence: string): void {
  for (const token of sequence.match(/<[a-z]+>|./gsu) ?? []) {
    const key: KeyEvent = token.length > 1 && token.startsWith("<")
      ? { type: token.slice(1, -1) === "esc" ? "escape" : token.slice(1, -1) } as KeyEvent
      : { type: "char", char: token };
    handleFocusedKey(key, state);
  }
}

/** Run keys from a normal-mode cursor; return buffer and cursor. */
function vim(buffer: string, cursor: number, sequence: string): { buffer: string; cursor: number } {
  const state = prompt(buffer, cursor);
  keys(state, sequence);
  return { buffer: state.inputBuffer, cursor: state.cursorPos };
}

describe("prompt j/k move by display rows", () => {
  // One logical line wrapped into three 10-column rows.
  const wrapped = "0123456789abcdefghijKLMNOPQRST";

  test("k and j step through a wrapped line's rows, keeping the column", () => {
    const state = prompt(wrapped, 25, "normal", 10);
    keys(state, "k");
    expect(state.cursorPos).toBe(15);
    keys(state, "k");
    expect(state.cursorPos).toBe(5);
    keys(state, "k");
    expect(state.cursorPos).toBe(5);
    keys(state, "jj");
    expect(state.cursorPos).toBe(25);
    keys(state, "2k");
    expect(state.cursorPos).toBe(5);
  });

  test("k at the top visible row of a scrolled prompt scrolls up one row", () => {
    const buffer = "x".repeat(50); // five 10-column rows
    const state = prompt(buffer, 45, "normal", 10);
    let view = getInputLines(buffer, state.cursorPos, 10, 2);
    expect(view.scrollOffset).toBe(3);

    keys(state, "k");
    view = getInputLines(buffer, state.cursorPos, 10, 2, view.scrollOffset);
    expect(state.cursorPos).toBe(35);
    expect(view.scrollOffset).toBe(3);
    expect(view.cursorLine).toBe(0);

    keys(state, "k");
    view = getInputLines(buffer, state.cursorPos, 10, 2, view.scrollOffset);
    expect(state.cursorPos).toBe(25);
    expect(view.scrollOffset).toBe(2);
    expect(view.cursorLine).toBe(0);

    keys(state, "jjj");
    view = getInputLines(buffer, state.cursorPos, 10, 2, view.scrollOffset);
    expect(state.cursorPos).toBe(45);
    expect(view.scrollOffset).toBe(3);
    expect(view.cursorLine).toBe(1);
  });

  test("insert-mode Up/Down also move by display rows", () => {
    const state = prompt(wrapped, 23, "insert", 10);
    handleFocusedKey({ type: "up" }, state);
    expect(state.cursorPos).toBe(13);
    handleFocusedKey({ type: "down" }, state);
    expect(state.cursorPos).toBe(23);
  });

  test("an end-of-row column never lands on the boundary that draws on the next row", () => {
    const state = prompt("0123456789abc", 13, "insert", 10);
    handleFocusedKey({ type: "end" }, state);
    handleFocusedKey({ type: "up" }, state);
    expect(state.cursorPos).toBe(9);
    expect(getInputLines(state.inputBuffer, state.cursorPos, 10, 5).cursorLine).toBe(0);
  });

  test("an insert cursor past a full-width line gets its own row and moves from there", () => {
    const buffer = "0123456789\nxyz";
    const view = getInputLines(buffer, 10, 10, 5);
    expect(view.lines).toEqual(["0123456789", "", "xyz"]);
    expect(view.lineStarts).toEqual([0, 10, 11]);
    expect([view.cursorLine, view.cursorCol]).toEqual([1, 0]);

    const up = prompt(buffer, 10, "insert", 10);
    handleFocusedKey({ type: "up" }, up);
    expect(up.cursorPos).toBe(0);

    const down = prompt(buffer, 10, "insert", 10);
    handleFocusedKey({ type: "down" }, down);
    expect(down.cursorPos).toBe(11);
  });

  test("$ makes j/k stick to the end of each line", () => {
    expect(vim("abcdef\nab\nabcdefgh", 0, "$jj").cursor).toBe(17);
  });

  test("f{char} finds j/k instead of moving vertically", () => {
    expect(vim("ab\nxjk", 3, "fj").cursor).toBe(4);
    expect(vim("ab\nxjk", 3, "fk").cursor).toBe(5);
  });
});

describe("prompt normal-mode arrow keys act as Vim motions", () => {
  test("Right and End stop on the line's last character", () => {
    expect(vim("ab\ncd", 1, "<right>").cursor).toBe(1);
    expect(vim("ab\ncd", 0, "<end>").cursor).toBe(1);
  });

  test("Down clamps to the last character like j", () => {
    expect(vim("abcdef\nx\nz", 5, "<down>").cursor).toBe(7);
  });

  test("Up/Down after an operator are linewise like k/j", () => {
    expect(vim("a\nb\nc", 0, "d<down>").buffer).toBe("c");
  });
});

describe("prompt normal-mode operators match Vim", () => {
  const cases: Array<[string, string, number, string, string, number]> = [
    // name, buffer, cursor, keys, expected buffer, expected cursor
    ["de is inclusive", "foo bar baz", 0, "de", " bar baz", 0],
    ["dE is inclusive", "foo.x bar", 0, "dE", " bar", 0],
    ["de from a word's end", "foo bar", 2, "de", "fo", 1],
    ["df includes the target", "a,b,c", 0, "df,", "b,c", 0],
    ["dF excludes the cursor", "a,b,c", 4, "dF,", "a,bc", 3],
    ["dt stops before the target", "foo(bar) x", 0, "dt(", "(bar) x", 0],
    ["dt next to the target deletes one char", "foo(bar) x", 2, "dt(", "fo(bar) x", 2],
    ["dt without a match does nothing", "a,b,c", 0, "dtz", "a,b,c", 0],
    ["cw changes to the word end", "foo bar", 0, "cwX<esc>", "X bar", 0],
    ["cw on a word's last char", "foo bar", 2, "cwX<esc>", "foX bar", 2],
    ["cw on blanks changes the blanks", "foo   bar", 3, "cwX<esc>", "fooXbar", 3],
    ["2cw", "foo bar baz", 0, "2cwX<esc>", "X baz", 0],
    ["cw stops at punctuation", "foo.bar", 0, "cwX<esc>", "X.bar", 0],
    ["dw on a line's last word keeps the line break", "foo bar\n  baz", 4, "dw", "foo \n  baz", 3],
    ["dw keeps the line break after trailing blanks", "foo   \n  bar", 0, "dw", "\n  bar", 0],
    ["2dw", "foo bar\nbaz qux", 0, "2dw", "\nbaz qux", 0],
    ["3dw crosses the line on an inner word", "foo bar\nbaz qux", 0, "3dw", "qux", 0],
    ["dw on an empty line deletes it", "abc\n\ndef", 4, "dw", "abc\ndef", 4],
    ["dw at the buffer end", "foo bar", 4, "dw", "foo ", 3],
    ["dl at a line's end", "ab\ncd", 1, "dl", "a\ncd", 0],
    ["dj deletes both lines", "a\n  b\nc\nd", 0, "dj", "c\nd", 0],
    ["dk deletes both lines", "a\nb\nc", 4, "dk", "a", 0],
    ["dj on the last line does nothing", "a\nb", 2, "dj", "a\nb", 2],
    ["5dj deletes what is there", "a\nb\nc", 0, "5dj", "", 0],
    ["cj changes whole lines", "a\nb\nc", 0, "cjX<esc>", "X\nc", 0],
    ["3dd", "a\nb\nc\nd", 0, "3dd", "d", 0],
    ["d3d", "a\nb\nc\nd", 0, "d3d", "d", 0],
    ["3dw", "a b c d", 0, "3dw", "d", 0],
    ["2d2w", "a b c d e", 0, "2d2w", "e", 0],
    ["2cc", "a\nb\nc", 0, "2ccX<esc>", "X\nc", 0],
    ["3x stops at the line end", "abc\ndef", 1, "3x", "a\ndef", 0],
    ["x at a line's end keeps the cursor on the line", "abc\nd", 2, "x", "ab\nd", 1],
    ["x on an empty line does nothing", "a\n\nb", 2, "x", "a\n\nb", 2],
    ["3X stops at the line start", "abcdef", 2, "3X", "cdef", 0],
    ["X at a line's start does nothing", "ab\ncd", 3, "X", "ab\ncd", 3],
    ["D on an empty line stays put", "a\n\nb", 2, "D", "a\n\nb", 2],
    ["2D", "abc\ndef\nghi", 1, "2D", "a\nghi", 0],
    ["2C", "abc\ndef\nghi", 1, "2CX<esc>", "aX\nghi", 1],
    ["3~", "abcdef", 0, "3~", "ABCdef", 3],
  ];

  for (const [name, buffer, cursor, sequence, expectedBuffer, expectedCursor] of cases) {
    test(name, () => {
      expect(vim(buffer, cursor, sequence)).toEqual({ buffer: expectedBuffer, cursor: expectedCursor });
    });
  }
});

describe("prompt normal-mode motions match Vim", () => {
  const cases: Array<[string, string, number, string, number]> = [
    ["$ rests on the last character", "ab\ncd", 0, "$", 1],
    ["^ goes to the first non-blank", "   abc", 5, "^", 3],
    ["w stops at an empty line", "abc\n\ndef", 0, "w", 4],
    ["W stops at an empty line", "abc\n\ndef", 0, "W", 4],
    ["b stops at an empty line", "abc\n\ndef", 5, "b", 4],
    ["e skips empty lines", "abc\n\ndef", 2, "e", 7],
    // A bare t/T is the jump-to-conversation shortcut; with a count it's a motion.
    ["2t, skips the adjacent match", "a,b,c,d", 0, "2t,", 2],
    ["2f", "a,b,c", 0, "2f,", 3],
  ];

  for (const [name, buffer, cursor, sequence, expectedCursor] of cases) {
    test(name, () => {
      expect(vim(buffer, cursor, sequence).cursor).toBe(expectedCursor);
    });
  }

  test("I inserts at the first non-blank", () => {
    expect(vim("    abc", 6, "IX<esc>").buffer).toBe("    Xabc");
  });

  test("a count does not leak past a find", () => {
    expect(vim("a,b,c\nx\ny", 0, "2f,j").cursor).toBe(6);
  });
});

describe("prompt visual mode matches Vim", () => {
  test("counts apply to visual motions", () => {
    expect(vim("abcdef", 0, "v3ld")).toEqual({ buffer: "ef", cursor: 0 });
  });

  test("o swaps the selection ends", () => {
    const state = prompt("abcdef", 1);
    keys(state, "vllo");
    expect(state.cursorPos).toBe(1);
    expect(state.vim.visualAnchor).toBe(3);
  });

  test("selection ends include the whole emoji", () => {
    expect(vim("a😀b", 0, "vld").buffer).toBe("b");
  });

  test("t extends to just before the target", () => {
    expect(vim("foo(bar)", 0, "vt(d").buffer).toBe("(bar)");
  });

  test("; after t/T skips the adjacent match", () => {
    expect(vim("a,b,c,d", 0, "vt,").cursor).toBe(0);
    expect(vim("a,b,c,d", 0, "vt,;").cursor).toBe(2);
    expect(vim("a,b,c,d", 6, "vT,;").cursor).toBe(4);
  });

  test("charwise selection across lines", () => {
    expect(vim("abc\ndef", 1, "vjd")).toEqual({ buffer: "af", cursor: 1 });
  });
});

describe("prompt linewise yank and put", () => {
  beforeEach(() => setTextClipboardSystemForTest({ platform: "linux", env: {}, commandExists: () => false }));
  afterEach(() => setTextClipboardSystemForTest(null));

  async function put(buffer: string, cursor: number, sequence: string) {
    const state = prompt(buffer, cursor);
    keys(state, sequence);
    await pasteFromClipboard();
    await Promise.resolve();
    return { buffer: state.inputBuffer, cursor: state.cursorPos };
  }

  test("yy then p puts the line below", async () => {
    expect(await put("abc\ndef", 1, "yyp")).toEqual({ buffer: "abc\nabc\ndef", cursor: 4 });
  });

  test("yy then P puts the line above", async () => {
    expect(await put("abc\ndef", 5, "yyP")).toEqual({ buffer: "abc\ndef\ndef", cursor: 4 });
  });

  test("p after the last line", async () => {
    expect(await put("abc\ndef", 5, "yyp")).toEqual({ buffer: "abc\ndef\ndef", cursor: 8 });
  });

  test("put lands on the first non-blank", async () => {
    expect(await put("  abc\ndef", 3, "yyp")).toEqual({ buffer: "  abc\n  abc\ndef", cursor: 8 });
  });

  test("2yy and yj yank two lines", async () => {
    expect(await put("a\nb\nc", 0, "2yyp")).toEqual({ buffer: "a\na\nb\nb\nc", cursor: 2 });
    expect(await put("a\nb\nc", 0, "yjp")).toEqual({ buffer: "a\na\nb\nb\nc", cursor: 2 });
  });

  test("visual-line yank puts lines", async () => {
    expect(await put("a\nb", 2, "Vyp")).toEqual({ buffer: "a\nb\nb", cursor: 4 });
  });

  test("charwise yank still puts inline, with a count", async () => {
    expect(await put("ab", 0, "yl3p")).toEqual({ buffer: "aaaab", cursor: 3 });
  });

  test("a trailing newline stripped by the clipboard still counts as linewise", () => {
    const state = prompt("abc", 0);
    keys(state, "yy");
    expect(isLinewiseClipboardText("abc\n")).toBe(true);
    expect(isLinewiseClipboardText("abc")).toBe(true);
    expect(isLinewiseClipboardText("ab")).toBe(false);
  });
});
