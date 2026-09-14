import { describe, expect, test } from "bun:test";
import { providerToolNames } from "./provider-primitives";
import { getRegisteredTools, getToolDefs, buildExecutor } from "./registry";
import { resolveConversationToolPolicy } from "../tool-policy";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import { createConversation } from "../messages";
import { readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";

describe("provider-specific coding primitives", () => {
  test("OpenAI exposes only Codex filesystem/shell primitives and preserves Exocortex tools", () => {
    const names = providerToolNames(getRegisteredTools().map(tool => tool.name), "openai");
    for (const name of ["exec_command", "write_stdin", "apply_patch", "view_image", "browse", "exo", "chrono"]) expect(names).toContain(name);
    for (const name of ["bash", "read", "write", "edit", "patch", "glob", "grep", "goal"]) expect(names).not.toContain(name);
    expect(getToolDefs(names).find(tool => tool.name === "apply_patch")?.freeform?.syntax).toBe("lark");
  });

  test("other providers retain existing tools; goal cannot be invoked", async () => {
    const names = providerToolNames(getRegisteredTools().map(tool => tool.name), "deepseek");
    for (const name of ["bash", "read", "write", "edit", "patch", "glob", "grep"]) expect(names).toContain(name);
    for (const name of ["exec_command", "write_stdin", "apply_patch", "view_image", "goal"]) expect(names).not.toContain(name);
    const [result] = await buildExecutor()([{ id: "disabled", name: "goal", input: { objective: "not allowed" } }]);
    expect(result.isError).toBe(true);
  });

  test("a legacy read-only allowlist does not gain arbitrary shell or patch authority", () => {
    expect(providerToolNames(["read", "glob", "grep", "browse"], "openai")).toEqual(["browse", "view_image"]);
    expect(providerToolNames(["edit"], "openai")).not.toContain("apply_patch");
  });

  test("new primitive names cannot bypass legacy per-tool safety rules", async () => {
    const previous = readExocortexConfig();
    try {
      writeExocortexConfig({ ...previous, safety: { enabled: true,
        bash: ["blocked-shell-fixture"], patch: ["blocked-patch-fixture"], read: ["blocked-image-fixture"],
      } });
      const execute = buildExecutor({ provider: "openai" });
      for (const call of [
        { id: "exec", name: "exec_command", input: { cmd: "echo blocked-shell-fixture" } },
        { id: "stdin", name: "write_stdin", input: { session_id: 1, chars: "blocked-shell-fixture" } },
        { id: "patch", name: "apply_patch", input: { input: "blocked-patch-fixture" } },
        { id: "image", name: "view_image", input: { path: "blocked-image-fixture.png" } },
      ]) {
        const [result] = await execute([call]);
        expect(result.isError).toBe(true);
        expect(result.output).toContain("blocked");
      }
    } finally { writeExocortexConfig(previous); }
  });

  test("surface, system hints, and executor agree, including a provider switch", async () => {
    const conv = createConversation("codex-profile-test", "openai", "gpt-5.6-sol");
    conv.toolPolicy = { internal: ["bash", "read", "patch", "goal", "chrono"], external: [], knownExternal: [] };
    const surface = buildConversationRequestSurface(conv, { conversationId: conv.id, workingDirectory: process.cwd() });
    expect(surface.toolNames).toContain("exec_command");
    expect(surface.toolNames).not.toContain("bash");
    expect(surface.system).toContain("## exec_command");
    expect(surface.system).not.toContain("## read\n");
    expect(surface.system).not.toContain("## goal\n");
    const [result] = await buildExecutor({ provider: "openai" }, surface.toolNames)([{ id: "legacy", name: "bash", input: { command: "echo should-not-run" } }]);
    expect(result.isError).toBe(true);
    conv.provider = "deepseek";
    expect(resolveConversationToolPolicy(conv).internalToolNames).toContain("bash");
    expect(resolveConversationToolPolicy(conv).internalToolNames).not.toContain("exec_command");
  });
});
