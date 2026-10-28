/**
 * `exocortexd proxy` entry point: carries the daemon's JSON-lines stream over
 * stdio (SSH, /proxy links). Kept apart from main.ts so each connection loads
 * only the bridge instead of the whole daemon, about 50 ms less per /ssh connect.
 *
 * `exocortexd proxy --link-only[=anthropic,openai]` carries only the /proxy
 * model link (ipc-link-filter.ts), for a forced command in authorized_keys.
 */

import { loadEnvFile } from "./env";
import { socketPath } from "@exocortex/shared/paths";
import { runIpcProxy } from "./ipc-proxy";
import { LinkOnlyFilter, parseLinkOnlyProviders } from "./ipc-link-filter";

loadEnvFile();
try {
  let filter: LinkOnlyFilter | undefined;
  for (const arg of process.argv.slice(2)) {
    const linkOnly = /^--link-only(?:=(.*))?$/.exec(arg);
    if (!linkOnly) throw new Error(`unknown option ${arg} (usage: exocortexd proxy [--link-only[=anthropic,openai]])`);
    filter = new LinkOnlyFilter({ providers: parseLinkOnlyProviders(linkOnly[1]) });
  }
  await runIpcProxy({ socketPath: socketPath(), filter });
} catch (err) {
  console.error(`exocortexd proxy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
