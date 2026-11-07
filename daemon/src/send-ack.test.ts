import { expect, test } from "bun:test";
import { join } from "node:path";

test("a prompt sent across a daemon restart or a dropped link runs once", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // orchestrator, handler and TUI client in an isolated child.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "send-ack.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("5 pass");
}, 60_000);
