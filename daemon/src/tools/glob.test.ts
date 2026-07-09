/**
 * Unit tests for daemon/src/tools/glob.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { glob } from "./glob";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exocortex-glob-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(root: string, rel: string, content = "x"): Promise<void> {
  const fullPath = join(root, rel);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("glob tool enhancements", () => {
  test("supports multiple include patterns plus excludes", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "src/a.ts");
    await writeFixture(root, "src/b.js");
    await writeFixture(root, "src/skip.d.ts");
    await writeFixture(root, "README.md");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      patterns: ["**/*.ts", "**/*.js"],
      exclude: ["**/*.d.ts"],
      sort: "path",
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["src/a.ts", "src/b.js"]);
  });

  test("supports limit after configurable sorting", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "small.txt", "tiny");
    await writeFixture(root, "large.txt", "this file is much larger than small.txt");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      pattern: "*.txt",
      sort: "size_desc",
      limit: 1,
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["large.txt"]);
  });

  test("a bare star is shallow and does not traverse unrelated descendants", async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTempDir();
    await writeFixture(root, "visible.txt");
    await writeFixture(root, "blocked/secret.txt");
    await chmod(join(root, "blocked"), 0o000);

    try {
      const result = await glob.execute({
        path: root,
        no_ignore: true,
        pattern: "*",
        sort: "path",
      });

      expect(result.isError).toBe(false);
      expect(lines(result.output)).toEqual(["visible.txt"]);
      expect(result.output).not.toContain("glob skipped");
    } finally {
      await chmod(join(root, "blocked"), 0o700).catch(() => {});
    }
  });

  test("no_ignore retains hard safety exclusions for broad roots", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "visible.ts");
    await writeFixture(root, "node_modules/pkg/hidden.ts");
    await writeFixture(root, ".git/objects/also-hidden.ts");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      pattern: "**/*.ts",
      sort: "path",
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["visible.ts"]);
  });

  test("an excluded directory remains searchable when it is the explicit root", async () => {
    const root = await makeTempDir();
    const modules = join(root, "node_modules");
    await writeFixture(root, "node_modules/pkg/index.js");

    const result = await glob.execute({
      path: modules,
      no_ignore: true,
      pattern: "**/*.js",
      sort: "path",
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["pkg/index.js"]);
  });

  test("supports fuzzy path queries without an explicit glob pattern", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "package.json");
    await writeFixture(root, "src/server.ts");
    await writeFixture(root, "docs/readme.md");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      query: "pkg json",
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["package.json"]);
  });

  test("can return metadata as JSON lines", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "README.md", "hello");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      pattern: "README.md",
      metadata: true,
    });

    expect(result.isError).toBe(false);
    const [entry] = lines(result.output).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(entry.path).toBe("README.md");
    expect(entry.size).toBe(5);
    expect(entry.type).toBe("file");
    expect(typeof entry.modified).toBe("string");
  });

  test("does not follow symlink loops by default, even with no_ignore", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "real/file.txt");
    await symlink(root, join(root, "real/loop"), "dir");

    const result = await glob.execute({
      path: root,
      no_ignore: true,
      pattern: "**/*.txt",
      sort: "path",
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toEqual(["real/file.txt"]);
  });

  test("skips unreadable descendant directories instead of failing the whole scan", async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTempDir();
    await writeFixture(root, "visible.txt");
    await writeFixture(root, "blocked/secret.txt");
    await chmod(join(root, "blocked"), 0o000);

    try {
      const result = await glob.execute({
        path: root,
        no_ignore: true,
        pattern: "**/*.txt",
        sort: "path",
      });

      expect(result.isError).toBe(false);
      expect(result.output).toContain("visible.txt");
      expect(result.output).not.toContain("secret.txt");
      expect(result.output).toContain("[glob skipped 1 inaccessible/looping path");
    } finally {
      await chmod(join(root, "blocked"), 0o700).catch(() => {});
    }
  });

  test("explicit excludes prune directories before traversal", async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTempDir();
    await writeFixture(root, "visible.txt");
    await writeFixture(root, "blocked/secret.txt");
    await chmod(join(root, "blocked"), 0o000);

    try {
      const result = await glob.execute({
        path: root,
        no_ignore: true,
        pattern: "**/*.txt",
        exclude: ["blocked/**"],
        sort: "path",
      });

      expect(result.isError).toBe(false);
      expect(lines(result.output)).toEqual(["visible.txt"]);
      expect(result.output).not.toContain("glob skipped");
    } finally {
      await chmod(join(root, "blocked"), 0o700).catch(() => {});
    }
  });

  test("errors when the requested root itself is not a directory", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "not-a-directory.txt");

    const result = await glob.execute({
      path: join(root, "not-a-directory.txt"),
      no_ignore: true,
      pattern: "**/*",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("path is not a directory");
  });

  test("schema exposes symlink and sudo traversal controls", () => {
    const properties = glob.inputSchema.properties as Record<string, unknown>;
    expect(properties.follow_symlinks).toMatchObject({ type: "boolean" });
    expect(properties.sudo).toMatchObject({ type: "boolean" });
  });
});
