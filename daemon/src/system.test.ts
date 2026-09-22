import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import { buildSystemPrompt, getUserAddendum, reloadUserAddendum, setUserAddendum } from "./system";
import { getToolDefs } from "./tools/registry";
import { SCOPED_SUBAGENT_IDENTITY, SCOPED_SUBAGENT_WRAPPER_NOTE, subagentToolNames } from "./subagent-policy";

describe("system prompt", () => {
  test("includes Exocortex-owned tool/runtime guidance", () => {
    const prompt = buildSystemPrompt({
      conversationId: "internal-tool-headings",
      toolNames: ["read", "grep"],
      includeExternalToolHints: false,
    });

    expect(prompt).toContain([
      "- Exocortex conversation ID: internal-tool-headings",
      "",
      "# Internal tools",
      "## read",
      "Prefer the read tool over cat/head/tail for reading files.",
      "## grep",
      "Prefer the grep tool over grep/rg for searching file contents.",
    ].join("\n"));
  });

  test("includes the Exocortex conversation id in a conversation prompt", () => {
    const prompt = buildSystemPrompt({ conversationId: "conv-native-123" });

    expect(prompt).toContain("- Exocortex conversation ID: conv-native-123");
  });

  test("reports the conversation's explicit working directory", () => {
    const prompt = buildSystemPrompt({
      conversationId: "workspace-prompt",
      workingDirectory: "/tmp/exocortex/workspaces/workspace-prompt",
    });

    expect(prompt).toContain("- Working directory: /tmp/exocortex/workspaces/workspace-prompt");
  });

  test("includes compact native-subagent guidance", () => {
    const prompt = buildSystemPrompt({ conversationId: "nested" });

    expect(prompt).toContain("## exo\nDelegate only");
    expect(prompt).toContain("Depth defaults to 0");
    expect(prompt).toContain("Tool selection is not a sandbox");
    expect(prompt).toContain("commands/models for exact IDs");
    expect(prompt).toContain("## chrono\nPrefer chrono over shell sleep");
  });

  test("tells child turns their remaining native delegation budget", () => {
    const blocked = buildSystemPrompt({ conversationId: "nested-zero", subagentMaxDepth: 0 });
    expect(blocked).toContain("This turn's remaining native exo subagent depth is 0.");
    expect(blocked).toContain("No delegation or unrelated administration is available.");

    const nested = buildSystemPrompt({ conversationId: "nested-two", subagentMaxDepth: 2 });
    expect(nested).toContain("This turn's remaining native exo subagent depth is 2.");
    expect(nested).toContain("A child turn may receive at most max_depth=1.");
  });

  test("builds a minimal restricted prompt and tool set for scoped subagents", () => {
    const readOnlyTools = subagentToolNames(0, false);
    const prompt = buildSystemPrompt({
      conversationId: "scoped-child",
      subagentMaxDepth: 0,
      identity: SCOPED_SUBAGENT_IDENTITY,
      wrapperNote: SCOPED_SUBAGENT_WRAPPER_NOTE,
      toolNames: readOnlyTools,
      includeExternalToolHints: false,
      conversationInstructions: "Inherited safety constraint",
    });

    expect(prompt).toStartWith(SCOPED_SUBAGENT_IDENTITY);
    expect(prompt).toContain("Do only the assigned task.");
    expect(prompt).toContain("Do not inventory repositories");
    expect(prompt).toContain("Inherited safety constraint");
    expect(prompt).toContain("# Internal tools\n## read\n");
    expect(prompt).not.toContain("# External tools");
    expect(prompt).toContain("remaining native exo subagent depth is 0");
    expect(prompt).not.toContain("### subscriptions");
    expect(prompt).not.toContain("### subagents");
    expect(getToolDefs(readOnlyTools).map(tool => tool.name)).toEqual([
      "read", "glob", "grep", "browse", "exo",
    ]);
    expect(getToolDefs(subagentToolNames(0, true)).map(tool => tool.name)).toEqual([
      "bash", "read", "write", "glob", "grep", "edit", "patch", "browse", "exo", "chrono",
    ]);
    expect(getToolDefs(subagentToolNames(1, false)).map(tool => tool.name)).toContain("exo");
  });

  test("omits the conversation-id line for non-conversation utility prompts", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Exocortex conversation ID:");
    expect(prompt).not.toContain("remaining native exo subagent depth");
  });

  test("effective guidance never recommends absent coding primitives", () => {
    const prompt = buildSystemPrompt({ toolNames: ["exec_command", "exo"], includeExternalToolHints: false });
    expect(prompt).toContain("Read/search text with exec_command");
    expect(prompt).not.toContain("edit files with raw apply_patch");
    expect(prompt).not.toContain("Edit files using raw apply_patch");
    expect(prompt).not.toContain("Inspect local images with view_image");
    expect(prompt).not.toContain("Use write_stdin only");
    const restricted = buildSystemPrompt({ toolNames: ["read", "grep", "exo"], subagentMaxDepth: 0, includeExternalToolHints: false });
    expect(restricted).toContain("Read local text with read");
    expect(restricted).toContain("Search local text with grep");
    expect(restricted).toContain("No shell executor is available");
    expect(restricted).not.toContain("Read/search text with exec_command");
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
