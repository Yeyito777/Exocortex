import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import { buildSystemPrompt, getUserAddendum, reloadUserAddendum, setUserAddendum } from "./system";

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
    expect(prompt).toContain("Default to doing the work yourself. Spawn subagents only for substantial, independent workstreams");
    expect(prompt).toContain("Do not spawn subagents for ordinary repository inspection, routine planning, single-component implementation, or generic code review.");
    expect(prompt).toContain("Prefer no more than two active children");
    expect(prompt).toContain("Start reviews only after the implementation is stable.");
    expect(prompt).toContain("When an OpenAI subagent is warranted, omit `model` for the newest default (currently gpt-5.6-sol)");
    expect(prompt).toContain("Starting a subagent requires a short title of about three words");
    expect(prompt).toContain("Set max_depth=0 unless the child has a clear need to delegate a further independent workstream.");
    expect(prompt).toContain("Subagents start in the daemon's working directory");
  });

  test("tells child turns their remaining native delegation budget", () => {
    const blocked = buildSystemPrompt({ conversationId: "nested-zero", subagentMaxDepth: 0 });
    expect(blocked).toContain("This turn's remaining native exo subagent depth is 0.");
    expect(blocked).toContain("Do not call the native `exo` tool with action=send or action=queue.");

    const nested = buildSystemPrompt({ conversationId: "nested-two", subagentMaxDepth: 2 });
    expect(nested).toContain("This turn's remaining native exo subagent depth is 2.");
    expect(nested).toContain("A child turn may receive at most max_depth=1.");
  });

  test("omits the conversation-id line for non-conversation utility prompts", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Exocortex conversation ID:");
    expect(prompt).not.toContain("remaining native exo subagent depth");
  });

  test("preserves live app instructions on read errors and rejects stale writes", () => {
    const original = getUserAddendum();
    const path = join(configDir(), "system.md");
    try {
      setUserAddendum("Loaded instructions");
      writeFileSync(path, "External instructions\n");
      expect(() => setUserAddendum("Stale replacement", "Loaded instructions")).toThrow("App instructions changed since they were read");
      expect(reloadUserAddendum()).toBe("External instructions");

      rmSync(path, { force: true });
      mkdirSync(path);
      expect(() => reloadUserAddendum()).toThrow();
      expect(getUserAddendum()).toBe("External instructions");
    } finally {
      rmSync(path, { recursive: true, force: true });
      setUserAddendum(original);
    }
  });
});
