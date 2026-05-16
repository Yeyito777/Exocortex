/**
 * Unit tests for daemon/src/tools/glob.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
});
