import { expect, test } from "bun:test";
import { join } from "node:path";

test("real asynchronous admission, queues, compaction, rewrites and cancellation", () => {
  // Command-routing tests mock the orchestrator process-wide. Exercise the real
  // domain/worker path in its own isolated test-config child.
  // This test's own limit bounds the child; a case may take most of it under
  // load (the first one starts the loader workers). Kill a hung child in time
  // to report its output.
  const child = Bun.spawnSync([process.execPath, "test", "--timeout=12000", join(import.meta.dir, "async-conversation-loading.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 28_000,
    // A fresh config dir: inheriting the parent's would share its SQLite DB
    // (and wait on its locks) during a full-suite run.
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite", EXOCORTEX_TEST_CONFIG_READY: "", EXOCORTEX_CONFIG_DIR: "" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("12 pass");
  // A child process running every case, each with its own limit: 12 x 5 s would be the budget in place.
}, 30_000);
