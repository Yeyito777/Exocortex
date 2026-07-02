import { describe, expect, test } from "bun:test";
import { browserOpenCommand } from "./oauth";

describe("OAuth browser opener", () => {
  test("uses macOS open on Darwin", () => {
    expect(browserOpenCommand("https://example.com/auth", "darwin")).toEqual(["open", "https://example.com/auth"]);
  });

  test("uses xdg-open on Linux", () => {
    expect(browserOpenCommand("https://example.com/auth", "linux")).toEqual(["xdg-open", "https://example.com/auth"]);
  });

  test("uses PowerShell on Windows", () => {
    expect(browserOpenCommand("https://example.com/auth", "win32")).toEqual([
      "powershell",
      "-NoProfile",
      "-Command",
      'Start-Process "https://example.com/auth"',
    ]);
  });
});
