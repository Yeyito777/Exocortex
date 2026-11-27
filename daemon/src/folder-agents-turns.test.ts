import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("folder agents through real turns", () => {
  test("passes the orchestrator cases", () => {
    // handler.test.ts replaces the orchestrator module process-wide; run the
    // real-orchestrator cases in a child Bun process, as orchestrator-persistence does.
    const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "folder-agents-turns.cases.ts")], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      timeout: 20_000,
    });
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain("3 pass");
    expect(output).toContain("0 fail");
  }, 25_000);
});
