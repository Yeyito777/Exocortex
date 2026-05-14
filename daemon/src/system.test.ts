import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system";

describe("system prompt", () => {
  test("includes Exocortex-owned tool/runtime guidance", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("Prefer the read tool over cat/head/tail for reading files.");
  });
});
