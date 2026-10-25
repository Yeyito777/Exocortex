/**
 * TUI entry point (bin/exocortex). With --ssh, SSH starts before the TUI's few
 * hundred modules load, so its handshake overlaps them instead of following.
 */
import { offerEarlySshProcess } from "./early-ssh";
import { parseTuiLaunchArgs } from "./launchargs";
import { spawnReusingSshProxy } from "./ssh-mux";

try {
  const { sshAlias, showHelp } = parseTuiLaunchArgs(process.argv.slice(2));
  if (sshAlias && !showHelp) offerEarlySshProcess(sshAlias, spawnReusingSshProxy(sshAlias));
} catch {
  // main.ts reports invalid arguments.
}
await import("./main");
