import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPathDirectoryWithLookahead } from "./path-completion";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "exocortex-path-completion-"));
  roots.push(root);
  mkdirSync(join(root, "Workspace"));
  mkdirSync(join(root, "Archive"));
  writeFileSync(join(root, "Workspace", "project.txt"), "project");
  writeFileSync(join(root, "notes.txt"), "notes");
  writeFileSync(join(root, ".secret"), "hidden");
  return `${root}/`;
}

describe("daemon path completion", () => {
  test("sorts remote entries and returns bounded child lookahead", async () => {
    const directory = fixture();
    const listings = await listPathDirectoryWithLookahead(directory, "W");

    expect(listings[0]).toEqual({
      directory,
      prefix: "W",
      entries: [{ name: "Workspace", type: "dir" }],
    });
    expect(listings[1]).toEqual({
      directory: `${directory}Workspace/`,
      prefix: "",
      entries: [{ name: "project.txt", type: "file" }],
    });
  });

  test("keeps hidden entries cacheable and treats unreadable paths as misses", async () => {
    const directory = fixture();
    const [listing] = await listPathDirectoryWithLookahead(directory, ".");
    expect(listing.entries).toEqual([{ name: ".secret", type: "file" }]);

    expect(await listPathDirectoryWithLookahead(`${directory}missing/`, "")).toEqual([{
      directory: `${directory}missing/`,
      prefix: "",
      entries: [],
    }]);
    expect(await listPathDirectoryWithLookahead("unsupported-relative/", "")).toEqual([{
      directory: "unsupported-relative/",
      prefix: "",
      entries: [],
    }]);
  });
});

