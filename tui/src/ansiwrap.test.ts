import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./historycursor";
import { wrapAnsiLine } from "./ansiwrap";

describe("ANSI viewport wrapping", () => {
  test("moves a whole trailing word instead of orphaning its last character", () => {
    const wrapped = wrapAnsiLine("\x1b[48;2;9;13;53malpha beta gamma\x1b[0m", 15);

    expect(wrapped.lines.map(stripAnsi)).toEqual(["alpha beta", "gamma"]);
    expect(wrapped.joins).toEqual(["", " "]);
  });
});
