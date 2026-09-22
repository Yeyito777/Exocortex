import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import { resolveFileLink } from "./file-links";

const IDS: string[] = [];

function workspace(name: string): string {
  const id = `file-link-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  const path = conversationWorkspaceDir(id);
  mkdirSync(path, { recursive: true });
  return path;
}

afterEach(() => {
  for (const id of IDS.splice(0)) rmSync(conversationWorkspaceDir(id), { recursive: true, force: true });
});

describe("resolveFileLink", () => {
  test("resolves relative, encoded, absolute, file URL, and home paths on the daemon host", async () => {
    const root = workspace("forms");
    const id = root.split("/").at(-1)!;
    const relative = join(root, "reports", "result one.md");
    mkdirSync(join(root, "reports"));
    writeFileSync(relative, "hello");

    for (const target of [
      "reports/result%20one.md",
      relative,
      `file://${relative.replaceAll(" ", "%20")}`,
    ]) {
      expect(await resolveFileLink(id, target)).toEqual({
        path: relative,
        kind: "file",
        size: 5,
      });
    }

    const homeTarget = join(homedir(), `.exocortex-file-link-${crypto.randomUUID()}`);
    writeFileSync(homeTarget, "home");
    try {
      expect(await resolveFileLink(id, `~/${homeTarget.slice(homedir().length + 1)}`)).toEqual({
        path: homeTarget,
        kind: "file",
        size: 4,
      });
    } finally {
      rmSync(homeTarget, { force: true });
    }
  });

  test("returns canonical paths and directory metadata", async () => {
    const root = workspace("canonical");
    const id = root.split("/").at(-1)!;
    const directory = join(root, "actual");
    mkdirSync(directory);
    symlinkSync(directory, join(root, "alias"));

    const result = await resolveFileLink(id, "alias");
    expect(result.path).toBe(directory);
    expect(result.kind).toBe("directory");
    expect(result.size).toBeGreaterThanOrEqual(0);
  });

  test("rejects unsafe targets, missing paths, and non-file filesystem objects", async () => {
    const root = workspace("reject");
    const id = root.split("/").at(-1)!;
    symlinkSync("/dev/null", join(root, "device"));

    for (const target of [
      "javascript:notes.md",
      "data:text/plain,notes.md",
      "file://remote/tmp/notes.md",
      "notes%00.md",
      "notes\n.md",
      "//remote/notes.md",
    ]) {
      await expect(resolveFileLink(id, target)).rejects.toThrow("Invalid or unsupported local file link");
    }
    await expect(resolveFileLink(id, "missing.md")).rejects.toThrow();
    await expect(resolveFileLink(id, "device")).rejects.toThrow("regular file or directory");
  });
});
