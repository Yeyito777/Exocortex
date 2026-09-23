import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, storageDir, externalToolsDir, externalToolsTrashDir } from "./paths";
import type { MacroEnvironment } from "./protocol";

/** Call on the host whose filesystem the agent will use. No secrets are read. */
export function localMacroEnvironment(): MacroEnvironment {
  const toolsDir = externalToolsDir();
  let installedToolDirs: string[] = [];
  try {
    installedToolDirs = readdirSync(toolsDir, { withFileTypes: true })
      .filter(entry => {
        if (entry.name.startsWith(".")) return false;
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try { return statSync(join(toolsDir, entry.name)).isDirectory(); }
        catch { return false; }
      })
      .map(entry => entry.name)
      .sort();
  } catch { /* No external tools installed. */ }
  return {
    repoRoot: repoRoot(),
    storageDir: storageDir(),
    externalToolsDir: toolsDir,
    externalToolsTrashDir: externalToolsTrashDir(),
    pathStyle: process.platform === "win32" ? "win32" : "posix",
    installedToolDirs,
  };
}
