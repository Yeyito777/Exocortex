import { expect, test } from "bun:test";
import { join } from "node:path";

test("readonly workers, sparse windows, integrity, freshness and bounded reuse", () => {
  // Other repository files install process-wide provider/timer mocks. Keep real
  // worker teardown and large-fixture GC out of that shared mock environment.
  // Bun 1.3.14's monolithic run can crash in its GC timer heap at this boundary.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "conversation-loader.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: process.env,
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("39 pass");
}, 60_000);
