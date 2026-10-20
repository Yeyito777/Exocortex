import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { deleteUserMacro, listUserMacros, saveUserMacro, userMacrosPath } from "./user-macros";

afterEach(() => rmSync(userMacrosPath(), { force: true }));

describe("user macro storage", () => {
  test("round-trips through config/macros.json, sorted, without temp files", () => {
    expect(listUserMacros()).toEqual([]);
    expect(saveUserMacro({ name: "/zeta", expansion: "Z" }, { create: true })).toMatchObject({ replaced: false });
    saveUserMacro({ name: "/alpha", expansion: "first\nsecond", description: "Two lines" }, { create: true });
    const expected = [
      { name: "/alpha", expansion: "first\nsecond", description: "Two lines" },
      { name: "/zeta", expansion: "Z" },
    ];
    expect(listUserMacros()).toEqual(expected);
    expect(JSON.parse(readFileSync(userMacrosPath(), "utf8"))).toEqual({ version: 1, macros: expected });
    expect(readdirSync(dirname(userMacrosPath())).filter(name => name.includes("macros.json."))).toEqual([]);
  });

  test("create refuses to replace; a plain save updates in place", () => {
    saveUserMacro({ name: "/go-now", expansion: "one" }, { create: true });
    expect(() => saveUserMacro({ name: "/go-now", expansion: "two" }, { create: true })).toThrow("already exists");
    expect(saveUserMacro({ name: "/go-now", expansion: "two" })).toMatchObject({ replaced: true });
    expect(listUserMacros()).toEqual([{ name: "/go-now", expansion: "two" }]);
  });

  test("delete returns the removed macro and refuses unknown names", () => {
    saveUserMacro({ name: "/a", expansion: "A" }, { create: true });
    saveUserMacro({ name: "/b", expansion: "B" }, { create: true });
    expect(deleteUserMacro("/a")).toEqual({ macro: { name: "/a", expansion: "A" }, macros: [{ name: "/b", expansion: "B" }] });
    expect(() => deleteUserMacro("/a")).toThrow("No macro named /a");
    expect(() => deleteUserMacro("not a name")).toThrow("Invalid macro name");
    expect(listUserMacros()).toEqual([{ name: "/b", expansion: "B" }]);
  });

  test("invalid input never touches the file", () => {
    expect(() => saveUserMacro({ name: "/bad name", expansion: "x" })).toThrow("spaces");
    expect(() => saveUserMacro({ name: "/empty", expansion: "  " })).toThrow("needs some text");
    expect(existsSync(userMacrosPath())).toBe(false);
  });

  test("a hand-broken file is reported, not overwritten", () => {
    writeFileSync(userMacrosPath(), "{ not json");
    expect(listUserMacros()).toEqual([]);
    expect(() => saveUserMacro({ name: "/x", expansion: "x" })).toThrow("not valid JSON");
    expect(readFileSync(userMacrosPath(), "utf8")).toBe("{ not json");
  });

  test("hand-edited files may be a bare list and skip invalid entries", () => {
    writeFileSync(userMacrosPath(), JSON.stringify([{ name: "/ok", expansion: "fine" }, { name: "nope", expansion: "x" }]));
    expect(listUserMacros()).toEqual([{ name: "/ok", expansion: "fine" }]);
  });
});
