import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalToolsDir, externalToolsTrashDir, repoRoot, storageDir } from "./paths";
import { localMacroEnvironment } from "./macro-environment";

test("macro environment advertises this host's paths and tool directories, including symlinks", () => {
  const name = `macro-environment-test-${process.pid}`;
  // A temp external-tools dir: other test files read the checkout's at the same time.
  const previousToolsDir = process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR;
  process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR = mkdtempSync(join(tmpdir(), "exo-macro-environment-"));
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
    rmSync(root, { recursive: true, force: true });
    if (previousToolsDir === undefined) delete process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR;
    else process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR = previousToolsDir;
  }
});
