import { describe, expect, test } from "bun:test";
import { providerToolNames } from "./provider-primitives";
import { getRegisteredTools, getToolDefs, buildExecutor } from "./registry";
import { resolveConversationToolPolicy } from "../tool-policy";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import { createConversation } from "../messages";
import { readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("provider-specific coding primitives", () => {
  test("default OpenAI researchers can actually read/search files without shell or mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "research-policy-"));
    try {
      await writeFile(join(dir, "evidence.txt"), "research-needle\n");
      const conv = createConversation("research-test", "openai", "gpt-5.6-terra");
      conv.subagentMaxDepth = 0;
      conv.subagentPolicy = { parentConversationId: "parent", allowEdits: false, parentSystemInstructions: "" };
      const surface = buildConversationRequestSurface(conv, { conversationId: conv.id, workingDirectory: dir });
      expect(surface.toolNames).toContain("read");
      expect(surface.toolNames).toContain("grep");
      expect(surface.toolNames).toContain("glob");
      expect(surface.toolNames).toContain("exo");
      for (const name of ["exec_command", "write_stdin", "apply_patch", "bash"]) expect(surface.toolNames).not.toContain(name);
      const execute = buildExecutor({ provider: "openai", cwd: dir, conversationId: conv.id }, surface.toolNames);
      const [read] = await execute([{ id: "read", name: "read", input: { file_path: "evidence.txt" } }]);
      expect(read.isError).toBe(false);
      expect(read.output).toContain("research-needle");
      const [grep] = await execute([{ id: "grep", name: "grep", input: { path: dir, pattern: "research-needle" } }]);
      expect(grep.isError).toBe(false);
      expect(grep.output).toContain("evidence.txt");
      const [shell] = await execute([{ id: "blocked", name: "exec_command", input: { cmd: "exit 0" } }]);
      expect(shell.isError).toBe(true);
      conv.provider = "deepseek";
      const switched = resolveConversationToolPolicy(conv).internalToolNames;
      expect(switched).toContain("read");
      expect(switched).not.toContain("bash");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

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
    expect(providerToolNames(["read", "glob", "grep", "browse"], "openai")).toEqual(["read", "glob", "grep", "browse", "view_image"]);
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
