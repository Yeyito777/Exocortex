#!/usr/bin/env bun
/**
 * scripts/claude-account-token — run a Claude account on a long-lived token
 * (`claude setup-token`) instead of its four-week login
 * (daemon/src/providers/anthropic/account-token.ts, docs/claude-accounts.md).
 *
 * Usage:
 *   scripts/claude-account-token <account> [--secret NAME] [--minted DATE] [--check]
 *   scripts/claude-account-token <account> --remove
 *
 * Mint the token first, signed in to that account in the browser, and put it
 * in the secrets store without it ever reaching a file or the screen history:
 *
 *   CLAUDE_CONFIG_DIR=<any empty dir> claude setup-token
 *   secrets add CLAUDE_SETUP_TOKEN_<ACCOUNT> --stdin
 *
 * This then asks Anthropic, with one 1-token request, that the token is taken
 * and belongs to the organization the account's login is signed in to, and
 * records the secret's name, today as the day it was minted (or --minted) and
 * the account's owner in the accounts registry. The value is never printed.
 * The running daemon picks the change up by itself. `--check` only checks;
 * `--remove` puts the account back on its own login (the secret stays).
 */

import { claudeTokenExpiresAt, claudeTokenSecretName, listClaudeAccounts, setClaudeAccountToken, type ClaudeAccountToken } from "./accounts";
import { checkClaudeTokenValue } from "./account-token";
import { readStoredSecret } from "./api-credits";
import { getClaudeAuthStatus, isSubscriptionAuth } from "./cli";

const USAGE = "usage: scripts/claude-account-token <account> [--secret NAME] [--minted DATE] [--check] | <account> --remove\n";
const PURPOSE = "exocortex: claude-account-token checks a long-lived token";

function fail(message: string): never {
  process.stderr.write(`claude-account-token: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valued = new Set(["--secret", "--minted"]);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valued.has(arg)) options.set(arg, args[++index] ?? "");
    else if (arg.startsWith("-")) flags.add(arg);
    else positional.push(arg);
  }
  if (positional.length !== 1 || flags.has("-h") || flags.has("--help")) {
    process.stdout.write(USAGE);
    process.exit(positional.length === 1 ? 0 : 2);
  }
  const accountId = positional[0]!;
  const account = listClaudeAccounts().find(entry => entry.id === accountId);
  if (!account) fail(`no Claude account "${accountId}" (${listClaudeAccounts().map(entry => entry.id).join(", ")})`);

  if (flags.has("--remove")) {
    if (!account.token) fail(`"${account.id}" has no long-lived token`);
    setClaudeAccountToken(account.id, null);
    process.stdout.write(`"${account.id}" runs on its own login again (${account.token.secret} is still in the secrets store).\n`);
    return;
  }

  const secret = options.get("--secret") || account.token?.secret || claudeTokenSecretName(account.id);
  const minted = options.has("--minted") ? Date.parse(options.get("--minted")!) : Date.now();
  if (!Number.isFinite(minted) || minted > Date.now() + 86_400_000) fail(`not a past date: ${options.get("--minted")}`);
  const value = await readStoredSecret(secret, PURPOSE);
  if (!value) fail(`${secret} is not in the secrets store. Mint a token with \`claude setup-token\` and store it with: secrets add ${secret} --stdin`);

  // Who the account is: its own login says, while it lasts; after that, what was recorded with the last token.
  const login = await getClaudeAuthStatus(undefined, account.id).catch(() => null);
  const signedIn = login !== null && isSubscriptionAuth(login) && login.authMethod === "claude.ai";
  const owner = signedIn ? login : account.token;
  const answer = await checkClaudeTokenValue(value, owner?.orgId);
  if (answer.outcome === "rejected") fail(`Anthropic does not take ${secret} for "${account.id}": ${answer.detail}`);
  if (answer.outcome === "unknown") fail(`Anthropic did not answer (${answer.detail}); try again later`);
  const orgId = owner?.orgId ?? answer.orgId ?? undefined;
  const token: ClaudeAccountToken = {
    secret,
    mintedAt: new Date(minted).toISOString(),
    ...(owner?.email ? { email: owner.email } : {}),
    ...(orgId ? { orgId } : {}),
    ...(owner?.orgName ? { orgName: owner.orgName } : {}),
    ...(owner?.subscriptionType ? { subscriptionType: owner.subscriptionType } : {}),
  };
  const who = token.email ?? (orgId ? `organization ${orgId.slice(0, 8)}…` : account.id);
  const until = new Date(claudeTokenExpiresAt(token)).toISOString().slice(0, 10);
  const verified = owner?.orgId ? "its organization matches the account's" : "the account has no login to compare its organization with";
  if (flags.has("--check")) {
    process.stdout.write(`Anthropic takes ${secret} (${who}; ${verified}). Not recorded (--check).\n`);
    return;
  }
  setClaudeAccountToken(account.id, token);
  process.stdout.write(`"${account.id}" (${who}) now runs on ${secret}, good until about ${until}; ${verified}.\n`
    + "The daemon uses it from the account's next sign-in check (within 10 minutes, or at once after a restart).\n");
}

await main();
