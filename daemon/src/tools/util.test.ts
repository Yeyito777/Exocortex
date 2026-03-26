/**
 * Unit tests for daemon/src/tools/util.ts
 *
 * Covers: safeSlice, cap, getString, getNumber, getBoolean.
 */

import { describe, test, expect } from "bun:test";
import {
  MAX_OUTPUT_CHARS,
  safeSlice,
  cap,
  getString,
  getNumber,
  getBoolean,
  summarizeParams,
} from "./util";

// ── safeSlice ─────────────────────────────────────────────────────

describe("safeSlice", () => {
  test("returns the string unchanged when shorter than the limit", () => {
    expect(safeSlice("hello", 10)).toBe("hello");
  });

  test("returns the string unchanged when exactly at the limit", () => {
    expect(safeSlice("hello", 5)).toBe("hello");
  });

  test("truncates a longer string at the given limit", () => {
    expect(safeSlice("hello world", 5)).toBe("hello");
  });

  test("handles an empty string with limit 0", () => {
    expect(safeSlice("", 0)).toBe("");
  });

  test("handles an empty string with a positive limit", () => {
    expect(safeSlice("", 5)).toBe("");
  });

  test("handles a non-empty string with limit 0", () => {
    // str.length (5) > 0 → slice(0,0) = "", charCodeAt(-1) = NaN (not a surrogate) → ""
    expect(safeSlice("hello", 0)).toBe("");
  });

  test("truncates normally when the last kept char is a regular character", () => {
    // "abcdef" sliced at 3: last char is 'c' (0x63), not a surrogate
    expect(safeSlice("abcdef", 3)).toBe("abc");
  });

  // UTF-16 surrogate-pair safety -------------------------------------------

  test("removes the high surrogate when the cut lands between a surrogate pair", () => {
    // 😀 = U+1F600, stored as two UTF-16 code units: \uD83D (high) \uDE00 (low)
    // "ab😀cd" → code units: [97, 98, 0xD83D, 0xDE00, 99, 100], length = 6
    // Slicing at index 3 would leave a lone high surrogate → must be stripped
    const str = "ab\uD83D\uDE00cd"; // "ab😀cd"
    expect(safeSlice(str, 3)).toBe("ab");
  });

  test("keeps a complete surrogate pair when the cut falls after the low surrogate", () => {
    // Cutting "ab😀cd" at 4 keeps the full emoji intact
    const str = "ab\uD83D\uDE00cd";
    expect(safeSlice(str, 4)).toBe("ab\uD83D\uDE00"); // "ab😀"
  });

  test("returns the full string unchanged when limit equals length (emoji included)", () => {
    const str = "ab\uD83D\uDE00"; // "ab😀", length 4
    expect(safeSlice(str, 4)).toBe(str);
  });

  test("low surrogate at the boundary is not mistaken for a high surrogate", () => {
    // \uDE00 is a low surrogate (0xDE00 > 0xDBFF), so it should NOT be stripped
    // "a😀" → [97, 0xD83D, 0xDE00], length = 3
    // Slicing at 3 returns the whole string (str.length === end path).
    // Slicing at 2 returns "a\uD83D" — last char IS a high surrogate, so gets stripped → "a"
    const str = "a\uD83D\uDE00"; // "a😀"
    expect(safeSlice(str, 2)).toBe("a"); // high surrogate stripped
    expect(safeSlice(str, 3)).toBe(str); // at-limit, returned as-is
  });

  test("handles multiple emoji — split between two pairs strips to safe boundary", () => {
    // "😀😀" → [\uD83D, \uDE00, \uD83D, \uDE00], length = 4
    // Slicing at 3: sliced = [\uD83D, \uDE00, \uD83D] → last is high surrogate → strip → "😀"
    const str = "\uD83D\uDE00\uD83D\uDE00"; // "😀😀"
    expect(safeSlice(str, 3)).toBe("\uD83D\uDE00"); // first emoji only
  });
});

// ── cap ───────────────────────────────────────────────────────────

describe("cap", () => {
  test("returns an empty string unchanged", () => {
    expect(cap("")).toBe("");
  });

  test("returns short text unchanged", () => {
    const text = "short text";
    expect(cap(text)).toBe(text);
  });

  test("returns text unchanged when exactly at MAX_OUTPUT_CHARS", () => {
    const text = "a".repeat(MAX_OUTPUT_CHARS);
    expect(cap(text)).toBe(text);
  });

  test("truncates when one character over the limit", () => {
    const text = "a".repeat(MAX_OUTPUT_CHARS + 1);
    const result = cap(text);
    // Kept portion is exactly MAX_OUTPUT_CHARS "a"s
    expect(result.startsWith("a".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(result).toContain(
      `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 1} characters)`
    );
  });

  test("truncates when well over the limit", () => {
    const overBy = 5_000;
    const totalLen = MAX_OUTPUT_CHARS + overBy;
    const text = "x".repeat(totalLen);
    const result = cap(text);
    expect(result.startsWith("x".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(result).toContain(
      `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${totalLen} characters)`
    );
  });

  test("truncation message contains the exact original and limit character counts", () => {
    const totalChars = MAX_OUTPUT_CHARS + 123;
    const result = cap("z".repeat(totalChars));
    expect(result).toContain(`showed ${MAX_OUTPUT_CHARS} of ${totalChars} characters`);
  });

  test("strips a lone high surrogate at the cap boundary (no invalid UTF-16 in output)", () => {
    // Build: (MAX_OUTPUT_CHARS - 1) "a"s + emoji (2 code units) + padding
    // When capped at MAX_OUTPUT_CHARS, the cut lands on the high surrogate of the emoji.
    // safeSlice must strip it, yielding MAX_OUTPUT_CHARS-1 "a"s with no lone surrogate.
    const base = "a".repeat(MAX_OUTPUT_CHARS - 1); // 29 999 chars
    const text = base + "\uD83D\uDE00" + "extra";   // 29999 + 2 + 5 = 30 006 code units
    const result = cap(text);
    expect(result.startsWith(base)).toBe(true);
    // No lone high surrogate must appear in the result
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).toContain("output truncated");
  });
});

// ── getString ─────────────────────────────────────────────────────

describe("getString", () => {
  test("returns the value when it is a non-empty string", () => {
    expect(getString({ key: "hello" }, "key")).toBe("hello");
  });

  test("returns an empty string (empty string is a valid value)", () => {
    expect(getString({ key: "" }, "key")).toBe("");
  });

  test("returns undefined for a number value", () => {
    expect(getString({ key: 42 }, "key")).toBeUndefined();
  });

  test("returns undefined for a boolean value", () => {
    expect(getString({ key: true }, "key")).toBeUndefined();
  });

  test("returns undefined for a null value", () => {
    expect(getString({ key: null }, "key")).toBeUndefined();
  });

  test("returns undefined for an explicit undefined value", () => {
    expect(getString({ key: undefined }, "key")).toBeUndefined();
  });

  test("returns undefined for an object value", () => {
    expect(getString({ key: { nested: "val" } }, "key")).toBeUndefined();
  });

  test("returns undefined for an array value", () => {
    expect(getString({ key: ["a", "b"] }, "key")).toBeUndefined();
  });

  test("returns undefined when the key is absent", () => {
    expect(getString({}, "key")).toBeUndefined();
  });

  test("returns undefined when a different key is present", () => {
    expect(getString({ other: "hello" }, "key")).toBeUndefined();
  });
});

// ── getNumber ─────────────────────────────────────────────────────

describe("getNumber", () => {
  test("returns the value when it is a positive integer", () => {
    expect(getNumber({ key: 42 }, "key")).toBe(42);
  });

  test("returns zero (falsy but valid number)", () => {
    expect(getNumber({ key: 0 }, "key")).toBe(0);
  });

  test("returns a negative number", () => {
    expect(getNumber({ key: -7.5 }, "key")).toBe(-7.5);
  });

  test("returns a floating-point number", () => {
    expect(getNumber({ key: 3.14 }, "key")).toBe(3.14);
  });

  test("returns NaN (typeof NaN === 'number' — known JS quirk)", () => {
    // The implementation does a typeof check only; NaN passes it
    expect(getNumber({ key: NaN }, "key")).toBeNaN();
  });

  test("returns Infinity", () => {
    expect(getNumber({ key: Infinity }, "key")).toBe(Infinity);
  });

  test("returns undefined for a numeric string", () => {
    expect(getNumber({ key: "42" }, "key")).toBeUndefined();
  });

  test("returns undefined for a boolean value", () => {
    expect(getNumber({ key: true }, "key")).toBeUndefined();
  });

  test("returns undefined for a null value", () => {
    expect(getNumber({ key: null }, "key")).toBeUndefined();
  });

  test("returns undefined for an explicit undefined value", () => {
    expect(getNumber({ key: undefined }, "key")).toBeUndefined();
  });

  test("returns undefined for an object value", () => {
    expect(getNumber({ key: {} }, "key")).toBeUndefined();
  });

  test("returns undefined when the key is absent", () => {
    expect(getNumber({}, "key")).toBeUndefined();
  });
});

// ── getBoolean ────────────────────────────────────────────────────

describe("getBoolean", () => {
  test("returns true when the value is true", () => {
    expect(getBoolean({ key: true }, "key")).toBe(true);
  });

  test("returns false (falsy but valid boolean)", () => {
    expect(getBoolean({ key: false }, "key")).toBe(false);
  });

  test("returns undefined for the string 'true'", () => {
    expect(getBoolean({ key: "true" }, "key")).toBeUndefined();
  });

  test("returns undefined for the string 'false'", () => {
    expect(getBoolean({ key: "false" }, "key")).toBeUndefined();
  });

  test("returns undefined for the number 1", () => {
    expect(getBoolean({ key: 1 }, "key")).toBeUndefined();
  });

  test("returns undefined for the number 0", () => {
    expect(getBoolean({ key: 0 }, "key")).toBeUndefined();
  });

  test("returns undefined for a null value", () => {
    expect(getBoolean({ key: null }, "key")).toBeUndefined();
  });

  test("returns undefined for an explicit undefined value", () => {
    expect(getBoolean({ key: undefined }, "key")).toBeUndefined();
  });

  test("returns undefined for an object value", () => {
    expect(getBoolean({ key: {} }, "key")).toBeUndefined();
  });

  test("returns undefined when the key is absent", () => {
    expect(getBoolean({}, "key")).toBeUndefined();
  });

  test("returns undefined when a different key is present", () => {
    expect(getBoolean({ other: true }, "key")).toBeUndefined();
  });
});

// ── summarizeParams ─────────────────────────────────────────────────

describe("summarizeParams", () => {
  test("primary only — no extra params", () => {
    expect(summarizeParams("ls -la", { command: "ls -la" }, ["command"])).toBe("ls -la");
  });

  test("string param appended as --key value", () => {
    expect(summarizeParams("/foo/", { pattern: "/foo/", path: "src" }, ["pattern"]))
      .toBe("/foo/ --path src");
  });

  test("number param appended as --key value", () => {
    expect(summarizeParams("file.ts", { file_path: "file.ts", offset: 100 }, ["file_path"]))
      .toBe("file.ts --offset 100");
  });

  test("boolean true appended as --key", () => {
    expect(summarizeParams("**/*.ts", { pattern: "**/*.ts", no_ignore: true }, ["pattern"]))
      .toBe("**/*.ts --no_ignore");
  });

  test("boolean false is omitted", () => {
    expect(summarizeParams("**/*.ts", { pattern: "**/*.ts", no_ignore: false }, ["pattern"]))
      .toBe("**/*.ts");
  });

  test("null and undefined values are omitted", () => {
    expect(summarizeParams("cmd", { command: "cmd", opt: null, other: undefined }, ["command"]))
      .toBe("cmd");
  });

  test("multiple skip keys are all excluded", () => {
    expect(summarizeParams("file.ts", {
      file_path: "file.ts", old_string: "foo", new_string: "bar", replace_all: true,
    }, ["file_path", "old_string", "new_string"])).toBe("file.ts --replace_all");
  });

  test("multiple extra params appended in order", () => {
    expect(summarizeParams("cmd", {
      command: "cmd", timeout: 5000, await: 60,
    }, ["command"])).toBe("cmd --timeout 5000 --await 60");
  });

  test("dash-prefixed keys are used as-is (backwards compat)", () => {
    expect(summarizeParams("/pat/", {
      pattern: "/pat/", "-i": true, "-A": 5,
    }, ["pattern"])).toBe("/pat/ -i -A 5");
  });

  test("dash-prefixed boolean false is omitted", () => {
    expect(summarizeParams("/pat/", {
      pattern: "/pat/", "-i": false,
    }, ["pattern"])).toBe("/pat/");
  });
});
