import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalToolsDir } from "@exocortex/shared/paths";
import { localMacroEnvironment } from "@exocortex/shared/macro-environment";
import { initExternalTools, setLoadedExternalToolsForTest, stopExternalToolsAsync } from "./external-tools";

test("manifestless checkout additions and removals refresh the macro catalog", async () => {
  const name = `macro-catalog-test-${process.pid}`;
  const previousToolsDir = process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR;
  const toolsRoot = mkdtempSync(join(tmpdir(), "exo-macro-catalog-"));
  process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR = toolsRoot;
  const directory = join(externalToolsDir(), name);
  expect(directory).toBe(join(toolsRoot, name));
  const previousOverride = process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS;
  const previousPath = process.env.PATH;
  const restoreTools = setLoadedExternalToolsForTest([]);
  process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS = "0";
  let catalog: string[] = [];
  const waitFor = async (present: boolean) => {
    const deadline = Date.now() + 4_000;
    while (catalog.includes(name) !== present && Date.now() < deadline) await Bun.sleep(20);
    expect(catalog.includes(name)).toBe(present);
  };
  try {
    initExternalTools(() => { catalog = localMacroEnvironment().installedToolDirs; });
    mkdirSync(directory);
    await waitFor(true);
    rmSync(directory, { recursive: true });
    await waitFor(false);
  } finally {
    await stopExternalToolsAsync();
    rmSync(toolsRoot, { recursive: true, force: true });
    if (previousToolsDir === undefined) delete process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR;
    else process.env.EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR = previousToolsDir;
    restoreTools();
    if (previousOverride === undefined) delete process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS;
    else process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS = previousOverride;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}, 10_000);
