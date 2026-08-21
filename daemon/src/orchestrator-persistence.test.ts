import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("DB-first orchestrator persistence", () => {
  test("passes isolated persistence and daemon-owned turn-chain cases", () => {
    // handler.test.ts deliberately replaces the orchestrator module for command
    // routing coverage. Run the real-orchestrator cases in a child Bun process so
    // that process-wide module mock cannot turn these persistence checks into
    // false positives when the complete daemon suite runs in one worker.
    const child = Bun.spawnSync([
      process.execPath,
      "test",
      join(import.meta.dir, "orchestrator-persistence.cases.ts"),
    ], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain("10 pass");
    expect(output).toContain("0 fail");
  });
});
