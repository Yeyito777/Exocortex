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

  test("includes compact native-subagent guidance", () => {
    const prompt = buildSystemPrompt({ conversationId: "nested" });

    expect(prompt).toContain("Use the native `exo` tool for the current daemon and its subagents.");
    expect(prompt).toContain("Use subagents only when parallel work would materially improve speed or quality");
    expect(prompt).toContain("Starting a subagent requires a short title of about three words");
    expect(prompt).toContain("Set max_depth=0 unless a subagent clearly needs to delegate further.");
    expect(prompt).toContain("Subagents start in the daemon's working directory");
  });

  test("omits the conversation-id line for non-conversation utility prompts", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Exocortex conversation ID:");
    expect(prompt).not.toContain("Native exo subagent depth:");
  });
});
