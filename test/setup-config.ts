import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const PREFIX = "exocortex-test-config-";
const MINUTE_MS = 60 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

// `bun test` never runs the "exit" listener below, and killed runs can't, so
// every run used to leave its config dir in /tmp (thousands of them). Dirs are
// named after the creating pid; remove the ones whose process is gone and that
// haven't changed for 10 minutes (in case a run's pid isn't visible from here).
// Dirs from before the pid was in the name go once untouched for a day.
function sweepStaleConfigDirs(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    const pid = Number(/^exocortex-test-config-(\d+)-/.exec(name)?.[1]);
    // `bun test --parallel` runs each file in a fresh global with the
    // environment reset, so this preload runs again for every file a worker
    // takes, one file after another. This process's older dirs belong to
    // files it has finished.
    if (pid === process.pid) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (pid && isAlive(pid)) continue;
    const minAgeMs = pid ? 10 * MINUTE_MS : 24 * 60 * MINUTE_MS;
    try {
      if (Date.now() - statSync(path).mtimeMs < minAgeMs) continue;
    } catch {
      continue;
    }
    rmSync(path, { recursive: true, force: true });
  }
}

if (!process.env.EXOCORTEX_TEST_CONFIG_READY) {
  process.env.EXOCORTEX_TEST_CONFIG_READY = "1";
  process.env.EXOCORTEX_TEST = "1";

  const configured = process.env.EXOCORTEX_CONFIG_DIR?.trim();
  if (!configured) sweepStaleConfigDirs(tmpdir());
  const configDir = configured
    ? resolve(configured)
    : mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`));

  process.env.EXOCORTEX_CONFIG_DIR = configDir;
  mkdirSync(configDir, { recursive: true });

  if (!configured) {
    process.on("exit", () => {
      rmSync(configDir, { recursive: true, force: true });
    });
  }
}
