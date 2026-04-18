import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("browse source", () => {
  const source = readFileSync(join(import.meta.dir, "browse.ts"), "utf8");

  test("uses the current digestor Relevant Links prompt", () => {
    expect(source).toContain("You are a web page digestor");
    expect(source).toContain("Produce an extensive, and thorough digest");
    expect(source).toContain("Max 7 links");
    expect(source).toContain("1. [Title](URL)");
  });

  test("uses the current system hint", () => {
    expect(source).toContain("Browse tool uses an inner AI call to parse a markdown rendered version of the requested website before relaying relevant information to you. Adjust the prompt to your needs.");
  });

  test("does not import deterministic browse helpers", () => {
    expect(source).not.toContain('from "./browse/index"');
    expect(source).not.toContain("extractRelevantLinks(");
    expect(source).not.toContain("buildRelevantLinksSection(");
  });
});
