import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { externalToolsDir, externalToolsTrashDir, repoRoot, storageDir } from "./paths";
import { localMacroEnvironment } from "./macro-environment";

test("macro environment advertises this host's paths and tool directories, including symlinks", () => {
  const name = `macro-environment-test-${process.pid}`;
  const root = externalToolsDir();
  const directory = join(root, name);
  const link = join(root, `${name}-link`);
  const file = join(root, `${name}-file`);
  const hidden = join(root, `.${name}`);
  try {
    mkdirSync(directory, { recursive: true });
    mkdirSync(hidden);
    writeFileSync(file, "");
    symlinkSync(directory, link, "junction");
    const environment = localMacroEnvironment();
    expect(environment).toMatchObject({
      repoRoot: repoRoot(),
      storageDir: storageDir(),
      externalToolsDir: root,
      externalToolsTrashDir: externalToolsTrashDir(),
      pathStyle: process.platform === "win32" ? "win32" : "posix",
    });
    expect(environment.installedToolDirs).toContain(name);
    expect(environment.installedToolDirs).toContain(`${name}-link`);
    expect(environment.installedToolDirs).not.toContain(`${name}-file`);
    expect(environment.installedToolDirs).not.toContain(`.${name}`);
  } finally {
    for (const path of [link, file, hidden, directory]) rmSync(path, { recursive: true, force: true });
  }
});
