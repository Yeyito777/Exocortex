import { expect, test } from "bun:test";
import { join } from "node:path";

test("conversation instructions saved mid-turn wait for the turn, on both stores", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // orchestrator, handler and TUI event handling in an isolated child.
  for (const store of ["sqlite", "json"]) {
    const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "conversation-instructions-midturn.cases.ts")], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: store },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, `${store}: ${output}`).toBe(0);
    expect(output).toContain("0 fail");
    expect(output).toContain("4 pass");
  }
}, 60_000);
