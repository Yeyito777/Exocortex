/**
 * The SSH connection `--ssh` launches start before the TUI's modules load (see
 * launch.ts), handed to the first probe for that alias. A process that already
 * exited or failed to start is not handed over: the probe spawns its own and
 * reports that failure normally.
 */
import type { SshProcess } from "@exocortex/shared/ssh-transport";

let early: { alias: string; process: SshProcess; ended: boolean } | null = null;

export function offerEarlySshProcess(alias: string, process: SshProcess): void {
  const entry = { alias, process, ended: false };
  // Before the probe listens, a spawn error would otherwise be an unhandled 'error' event.
  process.once("error", () => { entry.ended = true; });
  process.once("close", () => { entry.ended = true; });
  early = entry;
}

/** The launch's SSH process for `alias`, once; null when there is none to use. */
export function takeEarlySshProcess(alias: string): SshProcess | null {
  const entry = early;
  early = null;
  if (!entry) return null;
  if (entry.alias !== alias || entry.ended) {
    try { entry.process.kill(); } catch { /* already gone */ }
    return null;
  }
  return entry.process;
}
