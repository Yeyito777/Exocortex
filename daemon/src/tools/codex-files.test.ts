import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { applyPatch, viewImage } from "./codex-files";
import { patch } from "./patch";

test("native apply_patch accepts absolute paths without changing legacy patch semantics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-patch-"));
  const path = join(cwd, "example.txt");
  const input = `*** Begin Patch\n*** Add File: ${path}\n+α\n*** End Patch\n`;
  try {
    expect((await patch.execute({ input }, { cwd })).isError).toBe(true);
    expect((await applyPatch.execute({ input }, { cwd })).isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("α\n");
    expect(applyPatch.summarize({ input }).detail).toBe(path);
    expect((await applyPatch.execute({ input: "*** Begin Patch\n*** Update File: example.txt\n@@\n-α\n+β\n*** End Patch\n" }, { cwd })).isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("β\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("view_image does not expose the text reader through its path schema", async () => {
  expect((await viewImage.execute({ path: "file.txt" })).isError).toBe(true);
  expect(viewImage.summarize({ path: "image.png" }).label).toBe("Image");
});
