import { describe, expect, test } from "bun:test";
import { buildAnthropicSystemPrompt } from "./system";

describe("Anthropic system prompt", () => {
  test("fully frames Anthropic as an Exocortex-owned tool/runtime surface", () => {
    const prompt = buildAnthropicSystemPrompt();

    expect(prompt).toContain("Use the Exocortex tools and shell-accessible CLIs explicitly described in this prompt.");
    expect(prompt).toContain("Do not assume Claude Code's built-in tools like Bash, Read, Edit, WebSearch, WebFetch, or ToolSearch exist");
    expect(prompt).toContain("Prefer the read tool over cat/head/tail for reading files.");
  });
});
