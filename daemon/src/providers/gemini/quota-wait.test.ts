import { expect, test } from "bun:test";
import { join } from "node:path";

test("real-orchestrator Gemini quota-wait cases", () => {
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "quota-wait.cases.ts")], {
    cwd: join(import.meta.dir, "..", "..", ".."), stdout: "pipe", stderr: "pipe", env: process.env, timeout: 40_000,
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("3 pass");
}, 45_000);
