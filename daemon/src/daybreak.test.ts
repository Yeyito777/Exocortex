import { expect, test } from "bun:test";
import { join } from "node:path";

test("isolated Daybreak boundary, persistence, turn and compaction cases", () => {
  // The full daemon suite replaces orchestrator/registry dependencies in other
  // files. Exercise the real implementations in a clean module graph.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "daybreak.cases.ts")], {
    cwd: join(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
}, 30_000);
