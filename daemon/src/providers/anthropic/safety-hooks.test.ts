import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateExocortexConfig } from "@exocortex/shared/config";
import { claudeCodeSafetyHooks, claudeCodeToolDenial } from "./safety-hooks";

describe("Claude Code tools honor the safety denylist", () => {
  test("Read, Grep, Bash, Edit and Write are refused the way Exocortex's own tools are", async () => {
    const root = mkdtempSync(join(tmpdir(), "exo-cc-safety-"));
    const secrets = join(root, "Sensitive");
    const workspace = join(root, "ws");
    mkdirSync(secrets);
    mkdirSync(workspace);
    const keys = join(secrets, "keys.sh");
    writeFileSync(keys, "x");
    updateExocortexConfig(config => {
      config.safety = { read: [keys], write: [keys], edit: [keys], grep: [keys], bash: [`*${keys}*`] };
    });
    try {
      expect(claudeCodeToolDenial("Read", { file_path: "../Sensitive/keys.sh" }, workspace)).toContain("Blocked by Exocortex safety denylist");
      expect(claudeCodeToolDenial("Grep", { pattern: "x", path: root }, workspace)).toContain("Blocked");
      expect(claudeCodeToolDenial("Bash", { command: `cat ${keys}` }, workspace)).toContain("Blocked");
      expect(claudeCodeToolDenial("Edit", { file_path: keys, old_string: "x", new_string: "y" }, workspace)).toContain("Blocked");
      expect(claudeCodeToolDenial("Write", { file_path: "../Sensitive/./keys.sh", content: "y" }, workspace)).toContain("Blocked");
      expect(claudeCodeToolDenial("Read", { file_path: "notes.md" }, workspace)).toBeNull();
      expect(claudeCodeToolDenial("mcp__exocortex__chrono", { action: "list" }, workspace)).toBeNull();

      const hook = claudeCodeSafetyHooks(workspace).PreToolUse![0]!.hooks[0]!;
      const denied = await hook({
        hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: keys }, tool_use_id: "t",
        session_id: "s", transcript_path: "", cwd: workspace,
      } as never, "t", { signal: new AbortController().signal });
      expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
      const allowed = await hook({
        hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "ok.md" }, tool_use_id: "t",
        session_id: "s", transcript_path: "", cwd: workspace,
      } as never, "t", { signal: new AbortController().signal });
      expect(allowed).toEqual({});
    } finally {
      updateExocortexConfig(config => { delete config.safety; });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a started and an adopted process register the same hook shape", () => {
    // Adoption re-sends hook registrations; the SDK numbers callbacks in order,
    // so the shape must not depend on anything but the matcher list.
    const started = claudeCodeSafetyHooks("/a");
    const adopted = claudeCodeSafetyHooks("/b");
    expect(Object.keys(started)).toEqual(Object.keys(adopted));
    expect(started.PreToolUse!.map(m => m.hooks.length)).toEqual(adopted.PreToolUse!.map(m => m.hooks.length));
  });
});
