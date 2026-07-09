/** Isolated subprocess entry point for the glob tool. */

import { executeGlobInProcess } from "./glob";

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const input = JSON.parse(raw) as Record<string, unknown>;
  const result = await executeGlobInProcess(input);
  process.stdout.write(JSON.stringify(result));
}

try {
  await main();
} catch (err) {
  process.stderr.write(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
}
