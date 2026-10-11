/**
 * Service-wrapper control commands that run while the daemon is up.
 *
 * A separate entry point from main.ts on purpose: these only talk to the live
 * daemon over its socket, and loading main.ts's module graph (~200ms) delayed
 * every `exocortexd restart`.
 *
 * Usage:
 *   bun run src/control-cli.ts prepare-restart   Interrupt streams for replay; prints their ids
 *   bun run src/control-cli.ts prepare-stop      Quiesce for a stop that resumes nothing
 */

import { loadEnvFile } from "./env";
loadEnvFile();

import { prepareRestartForReplay, prepareStopWithoutReplay } from "./control";

const command = process.argv[2];

try {
  if (command === "prepare-restart") {
    const result = await prepareRestartForReplay();
    if (result.convIds.length > 0) process.stdout.write(`${result.convIds.join("\n")}\n`);
    if (result.stillStreaming.length > 0) {
      console.error(`  ⚠ Still streaming after graceful interrupt timeout: ${result.stillStreaming.join(", ")}; restart will replay from saved history.`);
    }
  } else if (command === "prepare-stop") {
    await prepareStopWithoutReplay();
  } else {
    console.error("  ✗ Usage: control-cli.ts prepare-restart|prepare-stop");
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ✗ Failed to ${command === "prepare-stop" ? "prepare stop" : "prepare restart"}: ${message}\n`);
  process.exit(1);
}
