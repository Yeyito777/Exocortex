import { expect, test } from "bun:test";
import { join } from "node:path";

test("a prompt accepted while its sender is away shows once on re-open", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // orchestrator, handler and TUI event handling in an isolated child.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "queued-message-resync.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("6 pass");
}, 60_000);
