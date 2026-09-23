import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { externalToolsDir } from "@exocortex/shared/paths";
import { localMacroEnvironment } from "@exocortex/shared/macro-environment";
import { initExternalTools, setLoadedExternalToolsForTest, stopExternalToolsAsync } from "./external-tools";

test("manifestless checkout additions and removals refresh the macro catalog", async () => {
  const name = `macro-catalog-test-${process.pid}`;
  const directory = join(externalToolsDir(), name);
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
    rmSync(directory, { recursive: true, force: true });
    restoreTools();
    if (previousOverride === undefined) delete process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS;
    else process.env.EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS = previousOverride;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}, 10_000);
