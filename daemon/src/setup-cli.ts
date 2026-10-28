/**
 * Install/discovery commands that run without the daemon's module graph.
 *
 * Usage (from bin/exocortexd, which skips run-daemon.sh's `bun install` so
 * stdout stays clean for callers):
 *   bun run src/setup-cli.ts socket           Print the socket a client should use
 *   bun run src/setup-cli.ts doctor [--json]  Report what the install has and lacks
 */

import { clientSocketPath, collectDoctorReport, formatDoctorReport } from "./doctor";

const [command, ...args] = process.argv.slice(2);

if (command === "socket") {
  process.stdout.write(`${clientSocketPath()}\n`);
} else if (command === "doctor") {
  const json = args.includes("--json");
  const unknown = args.filter(arg => arg !== "--json");
  if (unknown.length > 0) {
    console.error(`  ✗ Unknown doctor option: ${unknown[0]}\n    Usage: exocortexd doctor [--json]`);
    process.exit(2);
  }
  const report = await collectDoctorReport();
  if (json) {
    // Exit 0 whenever a report was produced; callers read `ok`.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorReport(report, process.stdout.isTTY === true));
    process.exitCode = report.ok ? 0 : 1;
  }
} else {
  console.error("  ✗ Usage: setup-cli.ts socket|doctor [--json]");
  process.exit(2);
}
