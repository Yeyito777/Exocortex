import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grep } from "./grep";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exo-grep-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await chmod(join(dir, "blocked"), 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

describe("grep tool hardening", () => {
  test("finds files with matches", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "a.txt", "needle\n");
    await writeFixture(root, "b.txt", "haystack\n");

    const result = await grep.execute({ pattern: "needle", path: root, output_mode: "files_with_matches" });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("a.txt");
    expect(result.output).not.toContain("b.txt");
  });

  test("head_limit stops collection at the requested number of results", async () => {
    const root = await makeTempDir();
    for (let i = 0; i < 50; i++) {
      await writeFixture(root, `${String(i).padStart(3, "0")}.txt`, "needle\n");
    }

    const result = await grep.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
      head_limit: 3,
    });

    expect(result.isError).toBe(false);
    expect(lines(result.output)).toHaveLength(3);
  });

  test("skips unreadable descendant directories instead of failing the whole search", async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTempDir();
    await writeFixture(root, "visible.txt", "needle\n");
    await writeFixture(root, "blocked/secret.txt", "needle\n");
    await chmod(join(root, "blocked"), 0o000);

    const result = await grep.execute({ pattern: "needle", path: root, output_mode: "files_with_matches" });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("visible.txt");
    expect(result.output).not.toContain("secret.txt");
    expect(result.output).toContain("[grep skipped 1 inaccessible/looping path");
  });

  test("reports no matches plus traversal warnings when only skipped descendants had matches", async () => {
    if (process.getuid?.() === 0) return;
    const root = await makeTempDir();
    await writeFixture(root, "visible.txt", "haystack\n");
    await writeFixture(root, "blocked/secret.txt", "needle\n");
    await chmod(join(root, "blocked"), 0o000);

    const result = await grep.execute({ pattern: "needle", path: root, output_mode: "files_with_matches" });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("No matches found.");
    expect(result.output).toContain("[grep skipped 1 inaccessible/looping path");
  });

  test("does not follow symlink loops by default", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "real/file.txt", "needle\n");
    await symlink(root, join(root, "real/loop"), "dir");

    const result = await grep.execute({ pattern: "needle", path: root, output_mode: "files_with_matches" });

    expect(result.isError).toBe(false);
    expect(lines(result.output).filter(line => line.includes("file.txt"))).toHaveLength(1);
    expect(result.output).not.toContain("loop");
  });

  test("follow_symlinks is opt-in and symlink loops become warnings", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "real/file.txt", "needle\n");
    await symlink(root, join(root, "real/loop"), "dir");

    const result = await grep.execute({ pattern: "needle", path: root, output_mode: "files_with_matches", follow_symlinks: true, head_limit: 5 });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("real/file.txt");
    expect(result.output).toContain("[grep skipped");
  });

  test("errors with a targeted hint for multiple paths joined into one path string", async () => {
    const root = await makeTempDir();
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "needle\n");
    await writeFile(b, "needle\n");

    const result = await grep.execute({ pattern: "needle", path: `${a} ${b}` });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("multiple paths joined into one string");
    expect(result.output).toContain(a);
    expect(result.output).toContain(b);
  });

  test("errors with a targeted hint when path contains glob syntax", async () => {
    const root = await makeTempDir();
    const result = await grep.execute({ pattern: "needle", path: join(root, "*.txt") });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("grep.path is a literal file/directory path");
    expect(result.output).toContain("glob:");
  });

  test("invalid regex remains a real rg error", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "a.txt", "needle\n");

    const result = await grep.execute({ pattern: "([", path: root });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("rg error");
  });

  test("schema exposes no_ignore, symlink, and sudo controls", () => {
    const properties = grep.inputSchema.properties as Record<string, unknown>;
    expect(properties.no_ignore).toMatchObject({ type: "boolean" });
    expect(properties.follow_symlinks).toMatchObject({ type: "boolean" });
    expect(properties.sudo).toMatchObject({ type: "boolean" });
  });
});
