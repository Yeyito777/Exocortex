import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./historycursor";
import { wrapAnsiLine } from "./ansiwrap";

describe("ANSI viewport wrapping", () => {
  test("moves a whole trailing word instead of orphaning its last character", () => {
    const wrapped = wrapAnsiLine("\x1b[48;2;9;13;53malpha beta gamma\x1b[0m", 15);

    expect(wrapped.lines.map(stripAnsi)).toEqual(["alpha beta", "gamma"]);
    expect(wrapped.joins).toEqual(["", " "]);
  });

  test("breaks at a space just past the width rather than an earlier one", () => {
    const wrapped = wrapAnsiLine("\x1b[1malpha beta gamma\x1b[0m", 10);

    expect(wrapped.lines.map(stripAnsi)).toEqual(["alpha beta", "gamma"]);
    expect(wrapped.joins).toEqual(["", " "]);
  });

  test("does not start the next row with the space after a word filling the row", () => {
    const wrapped = wrapAnsiLine("\x1b[1mabcdefghij klm\x1b[0m", 10);

    expect(wrapped.lines.map(stripAnsi)).toEqual(["abcdefghij", "klm"]);
    expect(wrapped.joins).toEqual(["", " "]);
  });
});

describe("ANSI viewport wrapping SGR carry", () => {
  test("a zero truecolor component is not a reset", () => {
    const { lines } = wrapAnsiLine("\x1b[1m\x1b[48;2;0;5;15mhello world", 6);

    expect(lines[1]).toBe("\x1b[1m\x1b[48;2;0;5;15mworld");
  });

  test("256-color index 0 is not a reset", () => {
    const { lines } = wrapAnsiLine("\x1b[3m\x1b[38;5;0mhello world", 6);

    expect(lines[1]).toBe("\x1b[3m\x1b[38;5;0mworld");
  });

  test("a reset parameter drops earlier attributes", () => {
    expect(wrapAnsiLine("\x1b[1m\x1b[0;3mhello world", 6).lines[1]).toBe("\x1b[0;3mworld");
    expect(wrapAnsiLine("\x1b[1m\x1b[;3mhello world", 6).lines[1]).toBe("\x1b[;3mworld");
    expect(wrapAnsiLine("\x1b[1m\x1b[3;0mhello world", 6).lines[1]).toBe("world");
  });
});

