import { expect, test } from "bun:test";
import { join } from "node:path";

test("real asynchronous admission, queues, compaction, rewrites and cancellation", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // domain/worker path in its own isolated test-config child.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "async-conversation-loading.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("14 pass");
});
