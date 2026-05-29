import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { edit } from "./edit";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "exo-edit-test-"));
  tempDirs.push(dir);
  return dir;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("edit tool", () => {
  test("applies multiple disjoint replacements in one call", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "app.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta\n");

    const result = await edit.execute({
      path: filePath,
      edits: [
        { oldText: "beta", newText: "BETA" },
        { oldText: "delta", newText: "DELTA" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Successfully replaced 2 block(s)");
    expect(readText(filePath)).toBe("alpha\nBETA\ngamma\nDELTA\n");
  });

  test("matches each edit against the original file", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "chain.txt");
    writeFileSync(filePath, "one two three\n");

    const result = await edit.execute({
      path: filePath,
      edits: [
        { oldText: "one", newText: "two" },
        { oldText: "two", newText: "TWO" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("two TWO three\n");
  });

  test("rejects duplicate oldText matches", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "dupe.txt");
    writeFileSync(filePath, "foo\nfoo\n");

    const result = await edit.execute({
      path: filePath,
      edits: [{ oldText: "foo", newText: "bar" }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Found 2 occurrences");
    expect(readText(filePath)).toBe("foo\nfoo\n");
  });

  test("rejects overlapping edits", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "overlap.txt");
    writeFileSync(filePath, "abcdef\n");

    const result = await edit.execute({
      path: filePath,
      edits: [
        { oldText: "abc", newText: "ABC" },
        { oldText: "bcd", newText: "BCD" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("overlap");
    expect(readText(filePath)).toBe("abcdef\n");
  });

  test("preserves BOM and original CRLF line endings", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "crlf.txt");
    writeFileSync(filePath, "\uFEFFalpha\r\nbeta\r\n");

    const result = await edit.execute({
      path: filePath,
      edits: [{ oldText: "beta\n", newText: "BETA\n" }],
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("\uFEFFalpha\r\nBETA\r\n");
  });

  test("uses Pi-compatible fuzzy fallback for trailing whitespace and typographic punctuation", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "unicode.txt");
    writeFileSync(filePath, "const msg = “hello — world”;   \n");

    const result = await edit.execute({
      path: filePath,
      edits: [{ oldText: "const msg = \"hello - world\";", newText: "const msg = \"goodbye - world\";" }],
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("const msg = \"goodbye - world\";\n");
  });

  test("resolves relative paths from the current working directory", async () => {
    const cwd = tempWorkspace();
    mkdirSync(join(cwd, "src"));
    const filePath = join(cwd, "src", "app.ts");
    writeFileSync(filePath, "export const value = 1;\n");
    process.chdir(cwd);

    const result = await edit.execute({
      path: "src/app.ts",
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("export const value = 2;\n");
  });

  test("accepts Pi legacy top-level oldText/newText shape", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "legacy.txt");
    writeFileSync(filePath, "hello world\n");

    const result = await edit.execute({
      path: filePath,
      oldText: "world",
      newText: "there",
      edits: [],
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("hello there\n");
  });

  test("accepts edits encoded as a JSON string", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "string-edits.txt");
    writeFileSync(filePath, "hello world\n");

    const result = await edit.execute({
      path: filePath,
      edits: JSON.stringify([{ oldText: "world", newText: "there" }]),
    });

    expect(result.isError).toBe(false);
    expect(readText(filePath)).toBe("hello there\n");
  });

  test("rejects invalid edit entries", async () => {
    const cwd = tempWorkspace();
    const filePath = join(cwd, "invalid.txt");
    writeFileSync(filePath, "hello world\n");

    const result = await edit.execute({
      path: filePath,
      edits: [{ oldText: "world" }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("edits[0] must have string oldText and newText");
    expect(readText(filePath)).toBe("hello world\n");
  });

  test("exposes Pi-style schema", () => {
    expect(edit.inputSchema).toMatchObject({
      type: "object",
      required: ["path", "edits"],
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            required: ["oldText", "newText"],
          },
        },
      },
    });
    const properties = edit.inputSchema.properties as Record<string, unknown>;
    expect(properties.file_path).toBeUndefined();
    expect(properties.replace_all).toBeUndefined();
  });
});
