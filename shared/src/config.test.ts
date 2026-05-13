import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { resolve } from "path";
import { agentWorkingDirectory } from "./config";
import { agentCwdDir, repoRoot } from "./paths";

describe("agentWorkingDirectory", () => {
  test("defaults to the repo-local agent cwd", () => {
    expect(agentWorkingDirectory({})).toBe(agentCwdDir());
  });

  test("resolves relative paths from the repo root", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "scratch/agent" } }))
      .toBe(resolve(repoRoot(), "scratch/agent"));
  });

  test("expands home-relative paths", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "~/Workspace/playground/" } }))
      .toBe(resolve(homedir(), "Workspace/playground"));
  });

  test("keeps absolute paths absolute", () => {
    expect(agentWorkingDirectory({ agent: { workingDirectory: "/tmp/exocortex-agent" } }))
      .toBe("/tmp/exocortex-agent");
  });
});
