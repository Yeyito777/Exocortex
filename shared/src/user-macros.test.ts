import { describe, expect, test } from "bun:test";
import { MAX_USER_MACRO_EXPANSION_LENGTH, normalizeUserMacro, normalizeUserMacroList, userMacroNameError } from "./user-macros";

describe("user macro validation", () => {
  test("names start with a slash and use only word characters and dashes", () => {
    for (const name of ["/standup", "/ship-it", "/a_b", "/x2"]) expect(userMacroNameError(name)).toBeNull();
    expect(userMacroNameError("standup")).toContain("start with \"/\"");
    expect(userMacroNameError("/")).toContain("name after");
    expect(userMacroNameError("/two words")).toContain("spaces");
    expect(userMacroNameError("/tab\tname")).toContain("spaces");
    expect(userMacroNameError("/dots.no")).toContain("letters, digits");
    expect(userMacroNameError("/émoji")).toContain("letters, digits");
    expect(userMacroNameError(`/${"a".repeat(60)}`)).toContain("at most");
    expect(userMacroNameError("")).toContain("Give the macro a name");
  });

  test("normalizes text and descriptions and rejects empty or oversized text", () => {
    expect(normalizeUserMacro({ name: "/s", expansion: "\r\n  line one\r\nline two  \n", description: "  Daily\n standup " }))
      .toEqual({ name: "/s", expansion: "line one\nline two", description: "Daily standup" });
    expect(normalizeUserMacro({ name: "/s", expansion: "x", description: "  " })).toEqual({ name: "/s", expansion: "x" });
    expect(() => normalizeUserMacro({ name: "/s", expansion: "   " })).toThrow("needs some text");
    expect(() => normalizeUserMacro({ name: "/s", expansion: "x".repeat(MAX_USER_MACRO_EXPANSION_LENGTH + 1) })).toThrow("limited");
    expect(() => normalizeUserMacro({ name: "/s", expansion: "x", description: 3 })).toThrow("description");
    expect(() => normalizeUserMacro({ name: "s", expansion: "x" })).toThrow("start with");
    expect(() => normalizeUserMacro(null)).toThrow("Invalid macro");
  });

  test("a list keeps valid, first-named entries sorted by name", () => {
    expect(normalizeUserMacroList([
      { name: "/b", expansion: "B" },
      { name: "bad", expansion: "x" },
      { name: "/a", expansion: "A" },
      { name: "/b", expansion: "duplicate" },
    ])).toEqual([{ name: "/a", expansion: "A" }, { name: "/b", expansion: "B" }]);
    expect(normalizeUserMacroList({ not: "a list" })).toEqual([]);
  });
});
