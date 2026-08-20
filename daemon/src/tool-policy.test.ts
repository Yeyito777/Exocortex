import { describe, expect, test } from "bun:test";
import { createConversation } from "./messages";
import { setLoadedExternalToolsForTest, type LoadedTool } from "./external-tools";
import { scopedSubagentPromptOptions } from "./subagent-policy";
import { buildSystemPrompt } from "./system";
import { getToolDefs } from "./tools/registry";
import {
  applyToolPolicyMutation,
  buildToolPolicySnapshot,
  getDefaultSubagentInternalToolNames,
  resolveConversationToolPolicy,
} from "./tool-policy";

describe("conversation tool policy", () => {
  test("normal conversations default to installed internal tools", () => {
    const conv = createConversation("root", "openai", "gpt-5.6-sol");
    const resolved = resolveConversationToolPolicy(conv);
    expect(resolved.source).toBe("default");
    expect(resolved.configurableInternalToolNames).toContain("bash");
    expect(resolved.configurableInternalToolNames).toContain("exo");
  });

  test("normal conversations also default to every installed external tool", () => {
    const loaded: LoadedTool = {
      manifest: {
        name: "google",
        bin: "./bin/google",
        systemHint: "Google hint",
        display: { label: "Google", color: "#ffffff" },
      },
      binDir: "/tmp/google/bin",
      toolDir: "/tmp/google",
    };
    const restore = setLoadedExternalToolsForTest([loaded]);
    try {
      const conv = createConversation("root-external", "openai", "gpt-5.6-sol");
      expect(resolveConversationToolPolicy(conv).externalToolNames).toEqual(["google"]);
      expect(buildToolPolicySnapshot(conv).external).toEqual([
        { name: "google", label: "Google", enabled: true },
      ]);
    } finally {
      restore();
    }
  });

  test("new external manifests default enabled without re-enabling known disabled tools", () => {
    const loaded: LoadedTool[] = ["google", "duo"].map((name) => ({
      manifest: {
        name,
        bin: `./bin/${name}`,
        systemHint: `${name} hint`,
        display: { label: name, color: "#ffffff" },
      },
      binDir: `/tmp/${name}/bin`,
      toolDir: `/tmp/${name}`,
    }));
    const restore = setLoadedExternalToolsForTest(loaded);
    try {
      const conv = createConversation("new-external", "openai", "gpt-5.6-sol");
      conv.toolPolicy = {
        internal: ["read"],
        external: [],
        knownExternal: ["google"],
      };
      expect(resolveConversationToolPolicy(conv).externalToolNames).toEqual(["duo"]);
      expect(buildToolPolicySnapshot(conv).external).toEqual([
        { name: "google", label: "google", enabled: false },
        { name: "duo", label: "duo", enabled: true },
      ]);

      // Legacy exact policies did not record their manifest inventory. Their
      // selected names become the old inventory, so a missing installed tool is
      // treated as newly added and enabled immediately.
      conv.toolPolicy = { internal: ["read"], external: ["google"] };
      expect(resolveConversationToolPolicy(conv).externalToolNames).toEqual(["google", "duo"]);
    } finally {
      restore();
    }
  });

  test("legacy scoped defaults remain research-only unless edits were delegated", () => {
    const conv = createConversation("child", "openai", "gpt-5.6-sol");
    conv.subagentMaxDepth = 0;
    conv.subagentPolicy = { parentConversationId: "root", allowEdits: false, parentSystemInstructions: "" };
    expect(resolveConversationToolPolicy(conv).configurableInternalToolNames).toEqual(["read", "glob", "grep", "browse"]);

    conv.subagentPolicy.allowEdits = true;
    expect(resolveConversationToolPolicy(conv).configurableInternalToolNames).toEqual(
      getDefaultSubagentInternalToolNames(0, true),
    );
  });

  test("an exact selection controls schemas and exo still respects max depth", () => {
    const conv = createConversation("selected", "openai", "gpt-5.6-sol");
    conv.subagentMaxDepth = 0;
    conv.subagentPolicy = { parentConversationId: "root", allowEdits: false, parentSystemInstructions: "" };
    conv.toolPolicy = { internal: ["read", "write", "exo"], external: [] };
    expect(resolveConversationToolPolicy(conv).configurableInternalToolNames).toEqual(["read", "write"]);
  });

  test("regular policy status ignores an exhausted budget retained from a delegated turn", () => {
    const conv = createConversation("regular-after-delegation", "openai", "gpt-5.6-sol");
    conv.subagentMaxDepth = 0;
    conv.toolPolicy = { internal: ["read", "write", "exo"], external: [] };

    expect(resolveConversationToolPolicy(conv).configurableInternalToolNames).toEqual(["read", "write", "exo"]);
    expect(buildToolPolicySnapshot(conv).internal.find((tool) => tool.name === "exo")?.enabled).toBe(true);
    expect(resolveConversationToolPolicy(conv, 0).configurableInternalToolNames).toEqual(["read", "write"]);
  });

  test("mutating a regular policy preserves exo after an exhausted delegated turn", async () => {
    const conv = createConversation("regular-mutation-after-delegation", "openai", "gpt-5.6-sol");
    conv.subagentMaxDepth = 0;
    conv.toolPolicy = { internal: ["read", "write", "exo"], external: [] };

    const policy = await applyToolPolicyMutation(conv, {
      action: "disable",
      tools: [{ kind: "internal", name: "write" }],
    });

    expect(policy?.internal).toContain("exo");
    expect(policy?.internal).not.toContain("write");
  });

  test("enable, disable, and reset produce persisted exact policies", async () => {
    const conv = createConversation("mutations", "openai", "gpt-5.6-sol");
    conv.toolPolicy = { internal: ["read", "glob", "grep", "browse"], external: [] };

    const withWrite = await applyToolPolicyMutation(conv, { action: "enable", tools: [{ kind: "internal", name: "write" }] });
    expect(withWrite?.internal).toContain("write");
    conv.toolPolicy = withWrite;
    const withoutRead = await applyToolPolicyMutation(conv, { action: "disable", tools: [{ kind: "internal", name: "read" }] });
    expect(withoutRead?.internal).not.toContain("read");
    expect(await applyToolPolicyMutation(conv, { action: "reset" })).toBeNull();
  });

  test("snapshot distinguishes enabled and disabled tools and warns about bash", () => {
    const conv = createConversation("snapshot", "openai", "gpt-5.6-sol");
    conv.toolPolicy = { internal: ["read", "bash"], external: [] };
    const snapshot = buildToolPolicySnapshot(conv);
    expect(snapshot.source).toBe("explicit");
    expect(snapshot.internal.find((tool) => tool.name === "read")?.enabled).toBe(true);
    expect(snapshot.internal.find((tool) => tool.name === "write")?.enabled).toBe(false);
    expect(snapshot.shellWarning).toBe(true);

    conv.toolPolicy = { internal: ["read", "chrono"], external: [] };
    expect(buildToolPolicySnapshot(conv).shellWarning).toBe(true);
  });

  test("external policy mutations preserve Bash as the existing transport", async () => {
    const loaded: LoadedTool = {
      manifest: {
        name: "google",
        bin: "./bin/google",
        systemHint: "Google hint",
        display: { label: "Google", color: "#ffffff" },
      },
      binDir: "/tmp/google/bin",
      toolDir: "/tmp/google",
    };
    const restore = setLoadedExternalToolsForTest([loaded]);
    try {
      const conv = createConversation("external-mutation", "openai", "gpt-5.6-sol");
      conv.toolPolicy = { internal: ["read"], external: [] };
      const enabled = await applyToolPolicyMutation(conv, {
        action: "enable",
        tools: [{ kind: "external", name: "google" }],
      });
      expect(enabled).toEqual({
        internal: ["bash", "read"],
        external: ["google"],
        knownExternal: ["google"],
      });
      conv.toolPolicy = enabled;
      await expect(applyToolPolicyMutation(conv, {
        action: "disable",
        tools: [{ kind: "internal", name: "bash" }],
      })).rejects.toThrow("Cannot disable bash while external tools are enabled");
    } finally {
      restore();
    }
  });

  test("selected external tools keep the established Bash transport and manifest hints", () => {
    const loaded: LoadedTool[] = ["gmail", "google"].map((name) => ({
      manifest: {
        name,
        bin: `./bin/${name}`,
        systemHint: `${name.toUpperCase()} selected hint`,
        display: { label: name, color: "#ffffff" },
      },
      binDir: `/tmp/${name}/bin`,
      toolDir: `/tmp/${name}`,
    }));
    const restore = setLoadedExternalToolsForTest(loaded);
    try {
      const conv = createConversation("external-child", "openai", "gpt-5.6-sol");
      conv.subagentMaxDepth = 0;
      conv.subagentPolicy = { parentConversationId: "root", allowEdits: false, parentSystemInstructions: "" };
      conv.toolPolicy = {
        internal: ["read"],
        external: ["google"],
        knownExternal: ["gmail", "google"],
      };
      const resolved = resolveConversationToolPolicy(conv);
      expect(resolved.internalToolNames).toEqual(["bash", "read"]);
      expect(getToolDefs(resolved.internalToolNames).map((tool) => tool.name)).toEqual(["bash", "read"]);
      expect(buildToolPolicySnapshot(conv).internal.find((tool) => tool.name === "bash")?.enabled).toBe(true);

      const prompt = buildSystemPrompt({
        conversationId: conv.id,
        subagentMaxDepth: 0,
        ...(scopedSubagentPromptOptions(conv, 0) ?? {}),
      });
      expect(prompt).toContain("## google\nGOOGLE selected hint");
      expect(prompt).not.toContain("GMAIL selected hint");
    } finally {
      restore();
    }
  });
});
