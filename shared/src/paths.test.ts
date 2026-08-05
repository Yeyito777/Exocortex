import { describe, expect, test } from "bun:test";
import { basename, dirname, join, resolve } from "path";
import { agentCwdDir, assertSafeConversationWorkspaceId, conversationWorkspaceDir, conversationWorkspacesDir, repoRoot, socketPath, trashedConversationWorkspaceDir } from "./paths";

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

describe("conversation workspace paths", () => {
  test("derive live and trash paths beneath the instance data directory", () => {
    expect(conversationWorkspaceDir("123-abc123")).toBe(join(conversationWorkspacesDir(), "123-abc123"));
    expect(trashedConversationWorkspaceDir("123-abc123")).toContain(join("trash", "workspaces", "123-abc123"));
  });

  test("reject unsafe directory identities", () => {
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b", "a..b", "bad id", "bad:id", "bad\0id"]) {
      expect(() => assertSafeConversationWorkspaceId(id)).toThrow("Invalid conversation ID");
    }
  });
});
