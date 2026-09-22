import { describe, expect, test } from "bun:test";
import { parseLocalFileLinkTarget } from "./file-links";

describe("parseLocalFileLinkTarget", () => {
  test("decodes relative paths and local file URLs while preserving host-relative forms", () => {
    expect(parseLocalFileLinkTarget("reports/result%20one.md")).toBe("reports/result one.md");
    expect(parseLocalFileLinkTarget("~/notes.md")).toBe("~/notes.md");
    expect(parseLocalFileLinkTarget("file:///tmp/result%20one.md")).toBe("/tmp/result one.md");
    expect(parseLocalFileLinkTarget("file://localhost/tmp/result%20one.md")).toBe("/tmp/result one.md");
  });

  test("rejects unsupported schemes, remote URLs, network paths, and controls", () => {
    for (const target of [
      "",
      "#section",
      "//server/share",
      "https://example.com/a.md",
      "javascript:notes.md",
      "file://remote/tmp/notes.md",
      "file:///tmp/notes.md?download=1",
      "file:///tmp/notes.md#section",
      "notes%00.md",
      "notes%0A.md",
      "notes\n.md",
      "%2F%2Fserver%2Fshare",
      "%68ttp:notes.md",
    ]) {
      expect(parseLocalFileLinkTarget(target)).toBeNull();
    }
  });

  test("rejects malformed percent escapes and empty decoded paths", () => {
    expect(parseLocalFileLinkTarget("notes%ZZ.md")).toBeNull();
    expect(parseLocalFileLinkTarget("%20%20")).toBeNull();
  });
});
