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

    expect(prompt).toContain([
      "## exo",
      "### subagents",
      "Use the native `exo` tool for delegated work. Don't spawn subagents ever, unless it's work that benefits extraordinarily from parallel execution, requires subagents for testing, or the user requests it. Luna agents for grunt work, terra for slightly more intelligent work, sol for intelligent tasks. effort levels: low, medium, high, xhigh. Short title of 3 words is required for subagents. max_depth=0 unless subagents truly require more subagnets. Subagents get research tools and no external tools by default. Use internal_tools/external_tools for exact delegation. When send targets an existing conversation, supplying both lists persistently replaces its policy before the sent or queued turn; use the discovered tools command to change policy without sending. External CLIs retain their established Bash transport, and allow_edits=true remains legacy shorthand for shell and mutation access.",
      "### subscriptions",
      "When asked to manage external notification subscriptions, use action=commands with command=notifications; it can discover sources and defaults subscription targets to the active conversation.",
      "Subagents start in their own isolated conversation workspace, so include any separate target absolute directory and all necessary task context.",
      "## chrono",
      "Prefer chrono over shell sleep, polling background tasks, or cron. `wait` requires a `max_wait` safety limit and wakes immediately when the task finishes. `sleep` pauses this turn until the duration elapses; `wake` persists across daemon restarts; message wakes start a model turn, while command soft-wakes can use hard_wake to escalate failures or command-defined non-zero conditions.",
    ].join("\n"));
  });

  test("tells child turns their remaining native delegation budget", () => {
    const blocked = buildSystemPrompt({ conversationId: "nested-zero", subagentMaxDepth: 0 });
    expect(blocked).toContain("This turn's remaining native exo subagent depth is 0.");
    expect(blocked).toContain("Do not call the native `exo` tool with action=send or action=queue.");

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
    expect(prompt).not.toContain("remaining native exo subagent depth");
    expect(getToolDefs(readOnlyTools).map(tool => tool.name)).toEqual([
      "read", "glob", "grep", "browse",
    ]);
    expect(getToolDefs(subagentToolNames(0, true)).map(tool => tool.name)).toEqual([
      "bash", "read", "write", "glob", "grep", "edit", "patch", "browse", "chrono",
    ]);
    expect(getToolDefs(subagentToolNames(1, false)).map(tool => tool.name)).toContain("exo");
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
