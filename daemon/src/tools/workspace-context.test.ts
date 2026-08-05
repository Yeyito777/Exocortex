import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "./bash";
import { edit } from "./edit";
import { glob } from "./glob";
import { grep } from "./grep";
import { patch } from "./patch";
import { read } from "./read";
import { write } from "./write";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "exocortex-workspace-context-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("conversation workspace tool context", () => {
  test("bash launches its command in the explicit workspace", async () => {
    const cwd = workspace();
    const result = await bash.execute({ command: "pwd" }, { cwd });
    expect(result.isError).toBe(false);
    expect(result.output.trim()).toBe(cwd);
  });

  test("concurrent commands keep separate conversation workspaces", async () => {
    const first = workspace();
    const second = workspace();
    const [firstResult, secondResult] = await Promise.all([
      bash.execute({ command: "sleep 0.02; pwd" }, { conversationId: "first", cwd: first }),
      bash.execute({ command: "pwd" }, { conversationId: "second", cwd: second }),
    ]);
    expect(firstResult.output.trim()).toBe(first);
    expect(secondResult.output.trim()).toBe(second);
  });

  test("read, write, and edit resolve relative paths from the explicit workspace", async () => {
    const cwd = workspace();
    const written = await write.execute({ file_path: "note.txt", content: "before\n" }, { cwd });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("before\n");

    const edited = await edit.execute({
      path: "note.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }, { cwd });
    expect(edited.isError).toBe(false);

    const loaded = await read.execute({ file_path: "note.txt" }, { cwd });
    expect(loaded.isError).toBe(false);
    expect(loaded.output).toContain("after");
  });

  test("patch defaults to the explicit workspace", async () => {
    const cwd = workspace();
    const result = await patch.execute({
      input: "*** Begin Patch\n*** Add File: nested.txt\n+workspace patch\n*** End Patch",
    }, { cwd });
    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, "nested.txt"), "utf8")).toBe("workspace patch\n");
  });

  test("grep and glob default to the explicit workspace", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "needle.txt"), "conversation workspace marker\n");

    const grepResult = await grep.execute({ pattern: "workspace marker", output_mode: "content" }, { cwd });
    expect(grepResult.isError).toBe(false);
    expect(grepResult.output).toContain("needle.txt");

    const globResult = await glob.execute({ pattern: "**/*.txt", sort: "path" }, { cwd });
    expect(globResult.isError).toBe(false);
    expect(globResult.output).toContain("needle.txt");
  });
});
