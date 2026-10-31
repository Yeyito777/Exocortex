import { expect, test } from "bun:test";
import { join } from "node:path";

test("the daemon takes in what another process committed to its store", () => {
  // These cases need the SQLite backend, which is chosen once per process.
  const child = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "store-reload.cases.ts")], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 50_000,
    env: { ...process.env, EXOCORTEX_CONVERSATION_STORE: "sqlite" },
  });
  const output = child.stdout.toString() + child.stderr.toString();
  expect(child.exitCode, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toContain("6 pass");
}, 60_000);
