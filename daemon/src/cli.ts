/**
 * CLI subcommands for exocortexd.
 *
 * Standalone commands run outside the daemon process.
 * Each function is a complete subcommand — runs and exits.
 */

import { ensureAuthenticated } from "./auth";

// ── Login ──────────────────────────────────────────────────────────

export async function handleLogin(): Promise<void> {
  console.log("\n  Exocortex — Authentication\n");

  const { status, email } = await ensureAuthenticated({
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  const name = email ?? "unknown";
  if (status === "already_authenticated") {
    console.log(`  ✓ Already authenticated as ${name}\n`);
  } else if (status === "refreshed") {
    console.log(`  ✓ Session refreshed (${name})\n`);
  } else {
    console.log(`\n  ✓ Authenticated as ${name}\n`);
  }
}
