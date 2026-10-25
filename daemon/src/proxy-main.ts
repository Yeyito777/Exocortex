/**
 * `exocortexd proxy` entry point: carries the daemon's JSON-lines stream over
 * stdio (SSH, /proxy links). Kept apart from main.ts so each connection loads
 * only the bridge instead of the whole daemon, about 50 ms less per /ssh connect.
 */

import { loadEnvFile } from "./env";
import { socketPath } from "@exocortex/shared/paths";
import { runIpcProxy } from "./ipc-proxy";

loadEnvFile();
try {
  await runIpcProxy({ socketPath: socketPath() });
} catch (err) {
  console.error(`exocortexd proxy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
