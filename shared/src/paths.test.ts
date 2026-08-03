import { describe, expect, test } from "bun:test";
import { basename, dirname } from "path";
import { agentCwdDir, repoRoot, socketPath } from "./paths";

describe("agentCwdDir", () => {
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
