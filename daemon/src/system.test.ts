import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import {
  buildClaudeCodeSystemAppend,
  buildSystemPrompt,
  dedupeAgainstBase,
  getBaseInstructions,
  getGlobalInstructions,
  getUserAddendum,
  migrateGlobalInstructions,
  reloadUserAddendum,
  setUserAddendum,
  splitInstructionSections,
} from "./system";
import { buildConversationRequestSurface } from "./conversation-request-surface";
import { setLoadedExternalToolsForTest } from "./external-tools";
import type { Conversation } from "./messages";
import { getConversationToolNames, getToolDefs } from "./tools/registry";
import { setToolTextDirForTest, toolTextDir } from "./tools/tool-text";
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

    expect(prompt).toContain("## exo\nDo the user's task yourself by default");
    expect(prompt).toContain("otherwise sol fast");
    expect(prompt).toContain("same tools");
    expect(prompt).toContain("docs/daemon-ipc.md");
    expect(prompt).not.toContain("commands/models");
    expect(prompt).not.toContain("legacy:true");
    expect(prompt).not.toContain("needed for testing");
    expect(prompt).toContain("## chrono\nchrono is this conversation's scheduler: use it instead of shell sleep");
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
      "browse", "exec_command", "write_stdin", "apply_patch", "view_image", "exo", "chrono", "goal", "client_bash", "attach",
    ]);
  });

  test("omits the conversation-id line for non-conversation utility prompts", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain("Exocortex conversation ID:");
    expect(prompt).not.toContain("remaining native exo subagent depth");
  });

  test("tool guidance comes only from the tools' own hints", () => {
    const prompt = buildSystemPrompt({ toolNames: ["exec_command", "write_stdin", "exo"], includeExternalToolHints: false });
    expect(prompt).not.toContain("# Effective tool guidance");
    expect(prompt).not.toContain("Available internal tools:");
    // exec_command's hint carries what the hard-coded block used to say.
    expect(prompt).toContain("## exec_command\n");
    expect(prompt).toContain("References to a bash tool in instructions or tool docs mean exec_command");
    expect(prompt).toContain("quoted heredoc");
    expect(prompt).not.toContain("apply_patch for file edits");
    expect(prompt).not.toContain("Use view_image for local images");
    const restricted = buildSystemPrompt({ toolNames: ["read", "grep", "exo"], includeExternalToolHints: false });
    expect(restricted).toContain("## read\nPrefer the read tool");
    expect(restricted).toContain("## grep\nPrefer the grep tool");
    expect(restricted).not.toContain("exec_command");
    // A conversation without tools is told so.
    expect(buildSystemPrompt({ toolNames: [], includeExternalToolHints: false })).toContain("# Internal tools\nNone: this conversation offers no tools.");
  });

  test("a tool's hint expands its placeholders for the conversation's provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-hint-"));
    cpSync(toolTextDir(), dir, { recursive: true });
    const restore = setToolTextDirForTest(dir);
    try {
      writeFileSync(join(dir, "chrono.hint.md"), "Long waits: {{longWaits}}\n");
      const hint = (provider: "anthropic" | "openai") =>
        buildSystemPrompt({ toolNames: ["chrono"], provider, includeExternalToolHints: false });
      expect(hint("anthropic")).toContain("## chrono\nLong waits: Sleeps and waits of any practical length run inside the call");
      expect(hint("openai")).toContain("## chrono\nLong waits: Sleeps and waits with limits longer than five minutes suspend the provider turn");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("picks up edits made to system.md by hand", () => {
    const original = getUserAddendum();
    const path = join(configDir(), "system.md");
    try {
      setUserAddendum("Before");
      writeFileSync(path, "After the edit\n");
      expect(getUserAddendum()).toBe("After the edit");
      expect(buildClaudeCodeSystemAppend({ includeExternalToolHints: false })).toBe("After the edit");
    } finally {
      setUserAddendum(original);
    }
  });

  test("Claude Code append carries only Exocortex's additions", () => {
    const original = getUserAddendum();
    const restoreTools = setLoadedExternalToolsForTest([{
      manifest: { name: "demo", bin: "demo", systemHint: "Run `demo -h`.", display: { label: "Demo", color: "#ffffff" } },
      binDir: "/tmp/demo/bin",
      toolDir: "/tmp/demo",
    }]);
    try {
      setUserAddendum("App-wide instruction");
      const append = buildClaudeCodeSystemAppend({ conversationInstructions: "Conversation rule" });
      expect(append).toBe([
        "# External tools\n## demo\nRun `demo -h`.",
        "App-wide instruction",
        "# Conversation instructions\nConversation rule",
      ].join("\n\n"));

      const scoped = buildClaudeCodeSystemAppend({
        identity: SCOPED_SUBAGENT_IDENTITY,
        wrapperNote: SCOPED_SUBAGENT_WRAPPER_NOTE,
        includeExternalToolHints: false,
      });
      expect(scoped).toBe(`${SCOPED_SUBAGENT_IDENTITY}\n\n${SCOPED_SUBAGENT_WRAPPER_NOTE}\n\nApp-wide instruction`);

      setUserAddendum("");
      expect(buildClaudeCodeSystemAppend({ includeExternalToolHints: false })).toBe("");
    } finally {
      restoreTools();
      setUserAddendum(original);
    }
  });

  test("anthropic request surface sends the Claude Code append instead of the Exo prompt, and never the goal", () => {
    const original = getUserAddendum();
    try {
      setUserAddendum("App-wide instruction");
      const conversation = {
        id: "claude-surface",
        provider: "anthropic",
        model: "claude-opus-5-5",
        goal: { status: "active", objective: "Ship it" },
      } as unknown as Conversation;
      const surface = buildConversationRequestSurface(conversation, {
        conversationId: conversation.id,
        workingDirectory: "/tmp/claude-surface",
        conversationInstructions: "Conversation rule",
      });

      // The goal changes during a conversation, so it is a turn notice instead.
      expect(surface.system).toBe(buildClaudeCodeSystemAppend({ conversationInstructions: "Conversation rule" }));
      expect(surface.system).toContain("App-wide instruction");
      expect(surface.system).not.toContain("Conversation goal");
      expect(surface.system).not.toContain("You are Exo");
      expect(surface.system).not.toContain("# Internal tools");
      expect(surface.toolNames).toContain("goal");

      const openai = buildConversationRequestSurface({ ...conversation, provider: "openai", model: "gpt-6.1-sol" } as Conversation, {
        conversationId: conversation.id,
        workingDirectory: "/tmp/claude-surface",
      });
      expect(openai.system).not.toContain("Conversation goal");
    } finally {
      setUserAddendum(original);
    }
  });
});

describe("global instructions: tracked base + personal file", () => {
  const BASE = [
    "# Helper Tools",
    "Use helper-tools/.",
    "",
    "# System Prompts",
    "Keep prompts minimal.",
    "",
    "# PSA",
    "Restart with the exo tool.",
  ].join("\n");
  const basePath = () => join(configDir(), "system.base.md");
  const personalPath = () => join(configDir(), "system.md");
  const backups = () => readdirSync(configDir()).filter(name => name.startsWith("system.md.pre-split-"));
  const clean = () => {
    rmSync(basePath(), { force: true });
    for (const name of backups()) rmSync(join(configDir(), name), { force: true });
    setUserAddendum("");
  };

  test("layers the base before this install's own instructions, each optional", () => {
    try {
      writeFileSync(basePath(), `${BASE}\n`);
      setUserAddendum("# Latex\nUse latex.");
      expect(getBaseInstructions()).toBe(BASE);
      expect(getUserAddendum()).toBe("# Latex\nUse latex.");
      expect(getGlobalInstructions()).toBe(`${BASE}\n\n# Latex\nUse latex.`);
      expect(buildClaudeCodeSystemAppend({ includeExternalToolHints: false, conversationInstructions: "Conversation rule" }))
        .toBe(`${BASE}\n\n# Latex\nUse latex.\n\n# Conversation instructions\nConversation rule`);
      const prompt = buildSystemPrompt({ includeExternalToolHints: false });
      expect(prompt.indexOf("# Helper Tools")).toBeLessThan(prompt.indexOf("# Latex"));

      // A missing personal file is the base alone, without an error.
      rmSync(personalPath(), { force: true });
      expect(getUserAddendum()).toBe("");
      expect(getGlobalInstructions()).toBe(BASE);

      // Saving writes only the personal file; the base is untouched.
      setUserAddendum("Own rule.");
      expect(readFileSync(personalPath(), "utf8")).toBe("Own rule.\n");
      expect(readFileSync(basePath(), "utf8")).toBe(`${BASE}\n`);

      // Hand edits to the base apply without a restart; without a base only the personal text remains.
      writeFileSync(basePath(), "# Base\nChanged upstream.\n");
      expect(getGlobalInstructions()).toBe("# Base\nChanged upstream.\n\nOwn rule.");
      rmSync(basePath());
      expect(getGlobalInstructions()).toBe("Own rule.");
    } finally {
      clean();
    }
  });

  test("splits sections at top-level headings, ignoring fenced code", () => {
    expect(splitInstructionSections("Preamble.\n\n# A\nOne.\n\n\n# B\n```sh\n# not a heading\n```\nTwo.\n")).toEqual([
      "Preamble.",
      "# A\nOne.",
      "# B\n```sh\n# not a heading\n```\nTwo.",
    ]);
    expect(splitInstructionSections("")).toEqual([]);
  });

  test("dedupe drops identical base sections and keeps edited and new ones", () => {
    const personal = [
      "# Helper Tools",
      "Use helper-tools/.",
      "",
      "# System Prompts",
      "Keep prompts minimal. And short.",
      "",
      "# Latex",
      "Use latex.",
      "",
      "# PSA",
      "Restart with the exo tool.",
      "",
      "",
      "# CAPTCHAs",
      "Delegate them.",
    ].join("\n");
    expect(dedupeAgainstBase(personal, BASE)).toEqual({
      text: "# System Prompts\nKeep prompts minimal. And short.\n\n# Latex\nUse latex.\n\n# CAPTCHAs\nDelegate them.",
      removed: ["# Helper Tools", "# PSA"],
      edited: ["# System Prompts"],
    });
    // Base sections missing from the personal file are simply not there to remove.
    expect(dedupeAgainstBase("# Latex\nUse latex.", BASE)).toEqual({ text: "# Latex\nUse latex.", removed: [], edited: [] });
    // Only base sections: nothing of the install's own remains.
    expect(dedupeAgainstBase(`${BASE}\n`, BASE).text).toBe("");
  });

  test("migration rewrites the old combined file once, after a backup", () => {
    const combined = `${BASE.replace("# PSA", "# Latex\nUse latex.\n\n# PSA")}\n\n# CAPTCHAs\nDelegate them.\n`;
    try {
      writeFileSync(basePath(), `${BASE}\n`);
      writeFileSync(personalPath(), combined);
      const migration = migrateGlobalInstructions(new Date("2026-10-21T03:30:00.123Z"));
      expect(migration.removed).toEqual(["# Helper Tools", "# System Prompts", "# PSA"]);
      expect(migration.edited).toEqual([]);
      expect(migration.backup).toBe(join(configDir(), "system.md.pre-split-20261021T033000Z.bak"));
      expect(readFileSync(migration.backup!, "utf8")).toBe(combined);
      expect(readFileSync(personalPath(), "utf8")).toBe("# Latex\nUse latex.\n\n# CAPTCHAs\nDelegate them.\n");
      expect(getUserAddendum()).toBe("# Latex\nUse latex.\n\n# CAPTCHAs\nDelegate them.");
      // Each base section reaches the prompt once.
      expect(getGlobalInstructions().split("# Helper Tools").length).toBe(2);

      // Already deduplicated: left alone, no second backup.
      expect(migrateGlobalInstructions()).toEqual({ backup: null, removed: [], edited: [] });
      expect(backups()).toHaveLength(1);

      // An edited copy of a base section is kept, and reported.
      writeFileSync(personalPath(), "# PSA\nRestart differently.\n");
      expect(migrateGlobalInstructions()).toEqual({ backup: null, removed: [], edited: ["# PSA"] });
      expect(readFileSync(personalPath(), "utf8")).toBe("# PSA\nRestart differently.\n");

      // No personal file (a fresh clone): nothing to do, nothing created.
      rmSync(personalPath());
      expect(migrateGlobalInstructions()).toEqual({ backup: null, removed: [], edited: [] });
      expect(existsSync(personalPath())).toBe(false);
    } finally {
      clean();
    }
  });
});
