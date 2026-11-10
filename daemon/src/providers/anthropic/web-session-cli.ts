#!/usr/bin/env bun
/**
 * scripts/claude-web-session — store a Claude account's claude.ai session for the
 * limit resets on the Accounts screen (providers.anthropic.webResets,
 * daemon/src/providers/anthropic/web-resets.ts).
 *
 * Usage:
 *   scripts/claude-web-session <account> [--context NAME] [--check]
 *
 * It reads the `sessionKey` cookie of a whale vimbrowser context signed in
 * to that account on claude.ai (default context `claude-<account>`), checks
 * with one GET of the account's claude.ai usage that the session is that
 * account's, and stores it in the secrets store as CLAUDE_WEB_SESSION_<ACCOUNT>
 * (replacing an older one). The value is never printed. `--check` only checks.
 * Run it again whenever the Accounts screen says the web session expired.
 */

import { existsSync } from "fs";
import { join } from "path";
import { externalToolsDir } from "@exocortex/shared/paths";
import { listClaudeAccounts } from "./accounts";
import { getClaudeAuthStatus } from "./cli";
import { secretsBinary } from "./api-credits";
import { checkWebSession, webSessionSecretName, WEB_ORIGIN } from "./web-resets";

const CONTEXT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const PURPOSE = "exocortex: claude-web-session stores a claude.ai session";

function fail(message: string): never {
  process.stderr.write(`claude-web-session: ${message}\n`);
  process.exit(1);
}

function tool(name: string): string {
  const bundled = join(externalToolsDir(), `${name}-cli`, "bin", name === "vimbrowser" ? "vimbrowser-cli" : name);
  if (existsSync(bundled)) return bundled;
  const found = Bun.which(name === "vimbrowser" ? "vimbrowser-cli" : name);
  if (!found) fail(`${name === "vimbrowser" ? "vimbrowser-cli" : name} not found`);
  return found;
}

/** Runs a command; its output stays in memory (cookie values among it are never printed). */
async function run(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

interface Tab { id: number; url: string; context: string | null }

async function contextTabs(vimbrowser: string, context: string): Promise<Tab[]> {
  const result = await run([vimbrowser, "tabs", "--json"]);
  if (result.exitCode !== 0) fail(`vimbrowser-cli tabs failed: ${result.stderr.trim().split("\n").pop() ?? ""}`);
  const parsed = JSON.parse(result.stdout) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { tabs?: unknown })?.tabs;
  if (!Array.isArray(list)) fail("vimbrowser-cli tabs: unexpected output");
  return (list as Array<Record<string, unknown>>)
    .filter(tab => typeof tab?.id === "number" && tab.context === context)
    .map(tab => ({ id: tab.id as number, url: typeof tab.url === "string" ? tab.url : "", context }))
    // Tabs already on claude.ai first.
    .sort((a, b) => Number(b.url.startsWith(WEB_ORIGIN)) - Number(a.url.startsWith(WEB_ORIGIN)));
}

/** The context's claude.ai `sessionKey`, or null when it has none; undefined when the tab cannot say (not loaded). */
async function sessionFromTab(vimbrowser: string, tab: number): Promise<string | null | undefined> {
  const result = await run([vimbrowser, "cookies", String(tab), `${WEB_ORIGIN}/`, "--values"]);
  if (result.exitCode !== 0) return undefined;
  try {
    const cookies = (JSON.parse(result.stdout) as { cookies?: Array<Record<string, unknown>> }).cookies ?? [];
    const cookie = cookies.find(entry => entry.name === "sessionKey" && typeof entry.domain === "string" && entry.domain.replace(/^\./, "") === "claude.ai");
    return typeof cookie?.value === "string" && cookie.value ? cookie.value : null;
  } catch {
    return undefined;
  }
}

async function readSession(vimbrowser: string, context: string): Promise<string | null> {
  for (const tab of await contextTabs(vimbrowser, context)) {
    const session = await sessionFromTab(vimbrowser, tab.id);
    if (session !== undefined) return session;
  }
  // No loaded tab in the context: open one in the background, read it, close it.
  const opened = await run([vimbrowser, "open-context", "--brief", context, `${WEB_ORIGIN}/settings/usage`]);
  if (opened.exitCode !== 0) fail(`could not open a tab in context "${context}": ${opened.stderr.trim().split("\n").pop() ?? ""}`);
  const id = (() => {
    try {
      const reply = JSON.parse(opened.stdout) as Record<string, unknown>;
      const tab = (reply.tab ?? reply) as Record<string, unknown>;
      return typeof tab.id === "number" ? tab.id : null;
    } catch {
      return null;
    }
  })() ?? (await contextTabs(vimbrowser, context))[0]?.id;
  if (typeof id !== "number") fail(`could not find the tab opened in context "${context}"`);
  let session: string | null | undefined;
  for (let attempt = 0; attempt < 10 && session === undefined; attempt += 1) {
    await Bun.sleep(1_000);
    session = await sessionFromTab(vimbrowser, id);
  }
  await run([vimbrowser, "close-tab", String(id)]);
  if (session === undefined) fail(`the tab in context "${context}" did not load`);
  return session;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const contextAt = args.indexOf("--context");
  const context = contextAt >= 0 ? args[contextAt + 1] : undefined;
  const positional = args.filter((arg, index) => !arg.startsWith("--") && (contextAt < 0 || index !== contextAt + 1));
  if (positional.length !== 1 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write("usage: scripts/claude-web-session <account> [--context NAME] [--check]\n");
    process.exit(positional.length === 1 ? 0 : 2);
  }
  const accountId = positional[0]!;
  const account = listClaudeAccounts().find(entry => entry.id === accountId);
  if (!account) fail(`no Claude account "${accountId}" (${listClaudeAccounts().map(entry => entry.id).join(", ")})`);
  const browserContext = context ?? `claude-${account.id}`;
  if (!CONTEXT_RE.test(browserContext)) fail(`not a browser context name: ${browserContext}`);

  const status = await getClaudeAuthStatus(undefined, account.id);
  if (!status.orgId) fail(`Claude Code is not signed in to "${account.id}" with a claude.ai subscription; sign it in first`);

  const vimbrowser = tool("vimbrowser");
  const session = await readSession(vimbrowser, browserContext);
  if (!session) {
    fail(`browser context "${browserContext}" is not signed in to claude.ai. Sign in there as ${status.email ?? account.id}:\n`
      + `  vimbrowser-cli open-context ${browserContext} ${WEB_ORIGIN}/login\nthen run this again.`);
  }

  const result = await checkWebSession(session, status.orgId);
  if (!result.ok) {
    if (result.failure === "other_account") fail(`browser context "${browserContext}" is signed in to another claude.ai account, not ${status.email ?? account.id}`);
    if (result.failure === "expired") fail(`browser context "${browserContext}" has an expired claude.ai session (${result.detail}); sign in there again`);
    fail(`claude.ai did not answer (${result.failure}: ${result.detail}); try again later`);
  }
  const resets = result.credits
    ? `${result.credits.availableCount} reset${result.credits.availableCount === 1 ? "" : "s"} left${result.credits.nextExpiresAt ? `, nearest ends ${new Date(result.credits.nextExpiresAt).toISOString().slice(0, 10)}` : ""}`
    : "no resets left";
  const name = webSessionSecretName(account.id);
  if (check) {
    process.stdout.write(`Context "${browserContext}" holds ${account.id}'s claude.ai session (${resets}). Not stored (--check).\n`);
    return;
  }

  const secrets = secretsBinary() ?? fail("no `secrets` CLI found");
  const names = await run([secrets, "list"]);
  if (names.exitCode !== 0) fail("`secrets list` failed");
  if (names.stdout.split("\n").some(line => line.trim() === name)) {
    const removed = await run([secrets, "remove", "--purpose", PURPOSE, name]);
    if (removed.exitCode !== 0) fail(`could not replace ${name} in the secrets store`);
  }
  const added = await run([secrets, "add", "--stdin", "--purpose", PURPOSE, name], session);
  if (added.exitCode !== 0) fail(`could not store ${name} in the secrets store`);
  process.stdout.write(`Stored ${account.id}'s claude.ai session as ${name} (${resets}). The daemon reads it at its next poll (within 15 minutes).\n`);
}

await main();
