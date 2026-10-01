import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import { buildSystemPrompt, getUserAddendum, reloadUserAddendum, setUserAddendum } from "./system";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { SCOPED_SUBAGENT_IDENTITY, SCOPED_SUBAGENT_WRAPPER_NOTE } from "./subagent-policy";

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

    expect(prompt).toContain("## exo\nAlmost never use subagents:");
    expect(prompt).toContain("Default: sol fast");
    expect(prompt).toContain("same tools");
    expect(prompt).toContain("docs/daemon-ipc.md");
    expect(prompt).not.toContain("commands/models");
    expect(prompt).not.toContain("legacy:true");
    expect(prompt).not.toContain("needed for testing");
    expect(prompt).toContain("## chrono\nPrefer chrono over shell sleep");
  });

  test("tells child turns their remaining native delegation budget", () => {
    const blocked = buildSystemPrompt({ conversationId: "nested-zero", subagentMaxDepth: 0 });
    expect(blocked).toContain("depth-zero turn: do not delegate further");
    expect(blocked).toContain("Administration uses direct daemon IPC");

    const nested = buildSystemPrompt({ conversationId: "nested-two", subagentMaxDepth: 2 });
    expect(nested).not.toContain("max_depth");
  });

  test("builds a scoped identity without removing the standard tools", () => {
    const readOnlyTools = getConversationToolNames("openai");
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
    expect(prompt).toContain("# Internal tools\n## browse\n");
    expect(prompt).not.toContain("# External tools");
    expect(prompt).toContain("depth-zero turn");
    expect(prompt).not.toContain("### subscriptions");
    expect(prompt).not.toContain("### subagents");
    expect(getToolDefs(readOnlyTools).map(tool => tool.name)).toEqual([
      "browse", "exec_command", "write_stdin", "apply_patch", "view_image", "exo", "chrono", "goal",
    ]);
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
