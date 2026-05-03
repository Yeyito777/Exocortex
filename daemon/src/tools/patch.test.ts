import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { patch, patchInternalsForTest } from "./patch";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "exo-patch-test-"));
  tempDirs.push(dir);
  return dir;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("patch tool", () => {
  test("adds, updates, and deletes files in one Codex-style patch", async () => {
    const cwd = tempWorkspace();
    writeFileSync(join(cwd, "app.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(cwd, "old.txt"), "obsolete\n");

    const result = await patch.execute({
      cwd,
      input: `*** Begin Patch
*** Add File: nested/new.txt
+hello
+world
*** Update File: app.txt
@@
 alpha
-beta
+BETTA
 gamma
*** Delete File: old.txt
*** End Patch`,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("A nested/new.txt");
    expect(result.output).toContain("M app.txt");
    expect(result.output).toContain("D old.txt");
    expect(readText(join(cwd, "nested/new.txt"))).toBe("hello\nworld\n");
    expect(readText(join(cwd, "app.txt"))).toBe("alpha\nBETTA\ngamma\n");
    expect(existsSync(join(cwd, "old.txt"))).toBe(false);
  });

  test("renames an updated file with Move to", async () => {
    const cwd = tempWorkspace();
    writeFileSync(join(cwd, "source.txt"), "one\ntwo\nthree\n");

    const result = await patch.execute({
      cwd,
      input: `*** Begin Patch
*** Update File: source.txt
*** Move to: dest/renamed.txt
@@
 one
-two
+TWO
 three
*** End Patch`,
    });

    expect(result.isError).toBe(false);
    expect(existsSync(join(cwd, "source.txt"))).toBe(false);
    expect(readText(join(cwd, "dest/renamed.txt"))).toBe("one\nTWO\nthree\n");
  });

  test("rejects absolute patch paths", async () => {
    const cwd = tempWorkspace();
    const result = await patch.execute({
      cwd,
      input: `*** Begin Patch
*** Add File: /tmp/nope.txt
+nope
*** End Patch`,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("patch paths must be relative");
  });

  test("uses fuzzy matching for whitespace and typographic punctuation", async () => {
    const cwd = tempWorkspace();
    writeFileSync(join(cwd, "doc.txt"), "  hello — world   \n");

    const result = await patch.execute({
      cwd,
      input: `*** Begin Patch
*** Update File: doc.txt
@@
-hello - world
+goodbye - world
*** End Patch`,
    });

    expect(result.isError).toBe(false);
    expect(readText(join(cwd, "doc.txt"))).toBe("goodbye - world\n");
  });

  test("parses heredoc-wrapped input", () => {
    const parsed = patchInternalsForTest.parsePatch(`<<'EOF'
*** Begin Patch
*** Add File: hello.txt
+hi
*** End Patch
EOF`);

    expect(parsed.hunks).toHaveLength(1);
  });
});
