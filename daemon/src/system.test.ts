import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system";

describe("system prompt", () => {
  test("includes Exocortex-owned tool/runtime guidance", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("Prefer the read tool over cat/head/tail for reading files.");
  });

  test("includes the Exocortex conversation id in a conversation prompt", () => {
    const prompt = buildSystemPrompt({ conversationId: "conv-native-123" });

    expect(prompt).toContain("- Exocortex conversation ID: conv-native-123");
  });

  test("keeps the subagent-depth rule static instead of embedding a turn-specific allowance", () => {
    const prompt = buildSystemPrompt({ conversationId: "nested" });

    expect(prompt).toContain("For action=send or queue, max_depth is required");
    expect(prompt).not.toContain("Native exo subagent depth:");
  });

  test("omits the conversation-id line for non-conversation utility prompts", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Exocortex conversation ID:");
    expect(prompt).not.toContain("Native exo subagent depth:");
  });
});
