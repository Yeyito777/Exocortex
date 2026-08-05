import { describe, expect, test } from "bun:test";
import { basename, dirname, resolve } from "path";
import { agentCwdDir, repoRoot, socketPath } from "./paths";

describe("agentCwdDir", () => {
  test("uses the source checkout when launched by bun", () => {
    expect(repoRoot()).toBe(resolve(import.meta.dir, "../.."));
  });

  test("points at the repo-local scratch cwd", () => {
    expect(dirname(agentCwdDir())).toBe(repoRoot());
    expect(basename(agentCwdDir())).toBe(".exocortex-cwd");
  });
});

describe("socketPath", () => {
  test("fits the Unix-domain socket path limit in deep worktrees", () => {
    expect(Buffer.byteLength(socketPath())).toBeLessThan(108);
  });
});
