import { describe, expect, test } from "bun:test";
import { wordWrap } from "./textwrap";

describe("plain word wrapping", () => {
  test("breaks at a space just past the width rather than an earlier one", () => {
    const wrapped = wordWrap("alpha beta gamma", 10);

    expect(wrapped.lines).toEqual(["alpha beta", "gamma"]);
    expect(wrapped.cont).toEqual([false, true]);
    expect(wrapped.join).toEqual(["", " "]);
  });

  test("a word filling the row exactly keeps its following space as the join", () => {
    const wrapped = wordWrap("abcdefghij klm", 10);

    expect(wrapped.lines).toEqual(["abcdefghij", "klm"]);
    expect(wrapped.join).toEqual(["", " "]);
  });

  test("a row ending in spaces breaks before them", () => {
    expect(wordWrap("abc   def", 4).lines).toEqual(["abc", "def"]);
  });
});
