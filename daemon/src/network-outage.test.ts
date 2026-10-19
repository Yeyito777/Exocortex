import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("turns wait out network outages", () => {
  test("passes the real-orchestrator outage cases", () => {
    // handler.test.ts replaces the orchestrator module process-wide; run the
    // real-orchestrator cases in a child Bun process (as orchestrator-persistence does).
    const child = Bun.spawnSync([
      process.execPath,
      "test",
      join(import.meta.dir, "network-outage.cases.ts"),
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
