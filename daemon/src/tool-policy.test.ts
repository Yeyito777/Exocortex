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

  test("allow, deny, and reset produce persisted exact policies", () => {
    const conv = createConversation("mutations", "openai", "gpt-5.6-sol");
    conv.toolPolicy = { internal: ["read", "glob", "grep", "browse"], external: [] };

    const withWrite = applyToolPolicyMutation(conv, { action: "allow", tools: [{ kind: "internal", name: "write" }] });
    expect(withWrite?.internal).toContain("write");
    conv.toolPolicy = withWrite;
    const withoutRead = applyToolPolicyMutation(conv, { action: "deny", tools: [{ kind: "internal", name: "read" }] });
    expect(withoutRead?.internal).not.toContain("read");
    expect(applyToolPolicyMutation(conv, { action: "reset" })).toBeNull();
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

  test("selected external tools add only their broker and manifest hints", () => {
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
      conv.toolPolicy = { internal: ["read"], external: ["google"] };
      const resolved = resolveConversationToolPolicy(conv);
      expect(resolved.internalToolNames).toEqual(["read", "external"]);
      expect(getToolDefs(resolved.internalToolNames).map((tool) => tool.name)).toEqual(["read", "external"]);

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
