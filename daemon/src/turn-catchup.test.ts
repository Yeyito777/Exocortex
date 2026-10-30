import { expect, test } from "bun:test";
import { join } from "node:path";

test("app clients catch up with a running turn exactly once", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // server, handler and orchestrator in an isolated child.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "turn-catchup.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 50_000,
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("5 pass");
}, 60_000);
