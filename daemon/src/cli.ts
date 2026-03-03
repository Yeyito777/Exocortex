/**
 * CLI subcommands for exocortexd.
 *
 * Standalone commands run outside the daemon process.
 * Each function is a complete subcommand — runs and exits.
 */

import { loadAuth, saveAuth, isTokenExpired } from "./store";
import { login, refreshTokens, verifyAuth } from "./auth";

// ── Login ──────────────────────────────────────────────────────────

export async function handleLogin(): Promise<void> {
  console.log("\n  Exocortex — Authentication\n");

  // Check existing credentials
  const existing = loadAuth();
  if (existing?.tokens?.accessToken && !isTokenExpired(existing.tokens)) {
    const valid = await verifyAuth(existing.tokens.accessToken);
    if (valid) {
      console.log(`  ✓ Already authenticated as ${existing.profile?.email ?? "unknown"}\n`);
      return;
    }
  }

  // Try token refresh
  if (existing?.tokens?.refreshToken) {
    try {
      const newTokens = await refreshTokens(existing.tokens.refreshToken);
      saveAuth({ ...existing, tokens: newTokens, updatedAt: new Date().toISOString() });
      console.log(`  ✓ Session refreshed (${existing.profile?.email ?? "unknown"})\n`);
      return;
    } catch {}
  }

  // Full OAuth flow
  const result = await login((msg) => console.log(`  ${msg}`));
  saveAuth({ tokens: result.tokens, profile: result.profile, updatedAt: new Date().toISOString() });
  console.log(`\n  ✓ Authenticated as ${result.profile?.email ?? "unknown"}\n`);
}
