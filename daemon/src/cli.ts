/**
 * CLI subcommands for exocortexd.
 *
 * Standalone commands run outside the daemon process.
 * Each function is a complete subcommand — runs and exits.
 */

import { ensureAuthenticated } from "./auth";
import type { ProviderId } from "./messages";
import { getDefaultProvider } from "./providers/registry";

// ── Login ──────────────────────────────────────────────────────────

export async function handleLogin(providerArg?: string): Promise<void> {
  const provider = (providerArg as ProviderId | undefined) ?? getDefaultProvider().id;
  console.log(`\n  Exocortex — Authentication (${provider})\n`);

  const { status, email } = await ensureAuthenticated(provider, {
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  const name = email ?? provider;
  if (status === "already_authenticated") {
    console.log(`  ✓ Already authenticated as ${name}\n`);
  } else if (status === "refreshed") {
    console.log(`  ✓ Session refreshed (${name})\n`);
  } else {
    console.log(`\n  ✓ Authenticated as ${name}\n`);
  }
}
