import { describe, expect, test } from "bun:test";
import { basename, dirname } from "path";
import { agentCwdDir, repoRoot } from "./paths";

describe("agentCwdDir", () => {
  test("points at the repo-local scratch cwd", () => {
    expect(dirname(agentCwdDir())).toBe(repoRoot());
    expect(basename(agentCwdDir())).toBe(".exocortex-cwd");
  });
});
