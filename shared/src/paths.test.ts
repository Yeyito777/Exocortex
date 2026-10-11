import { describe, expect, test } from "bun:test";
import { basename, dirname, join, resolve } from "path";
import { agentCwdDir, assertSafeConversationWorkspaceId, conversationWorkspaceDir, conversationWorkspacesDir, repoRoot, socketPath, trashedConversationWorkspaceDir, worktreeFromDotGit } from "./paths";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

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

describe("worktreeFromDotGit", () => {
  const withRoot = (run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "exocortex-dotgit-"));
    try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };

  test("treats a .git directory as the main checkout", () => withRoot((root) => {
    mkdirSync(join(root, ".git"));
    expect(worktreeFromDotGit(join(root, ".git"))).toBeNull();
  }));

  test("names a linked worktree from its gitdir pointer", () => withRoot((root) => {
    const adminDir = join(root, "main", ".git", "worktrees", "feature-x");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, "commondir"), "../..\n");
    mkdirSync(join(root, "feature-x"));
    writeFileSync(join(root, "feature-x", ".git"), `gitdir: ${adminDir}\n`);
    expect(worktreeFromDotGit(join(root, "feature-x", ".git"))).toBe("feature-x");
  }));

  test("defers to git for anything else", () => withRoot((root) => {
    expect(worktreeFromDotGit(join(root, ".git"))).toBeUndefined();
    const moduleDir = join(root, "super", ".git", "modules", "sub");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${moduleDir}\n`);
    expect(worktreeFromDotGit(join(root, ".git"))).toBeUndefined();
  }));
});
