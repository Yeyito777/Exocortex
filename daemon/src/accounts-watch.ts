/**
 * The Accounts screen's data (`accounts` command): every Claude and OpenAI
 * account as structured fields, pushed again to watching clients whenever an
 * account changes. Only already-known state is sent; watching starts a
 * background refresh of stale sign-ins and usage, and repeats it each minute
 * while anyone watches, so the screen opens at once and fills in.
 *
 * While Claude goes through /proxy, the Claude accounts are the remote's
 * (provider-proxy/remote-accounts.ts) and the refresh asks the remote for it.
 */

import type { AccountsCommand, AccountsSnapshot, Event, OpenAIAccountInfo } from "./protocol";
import type { ConnectedClient } from "./server";
import type { UsageData } from "./messages";
import { log } from "./log";
import { isProviderProxied, providerProxyHooks, proxiedClaudeAccounts } from "./provider-proxy/route";
import { mergeRemoteAccounts } from "./provider-proxy/remote-accounts";
import { getLastUsage } from "./usage";
import { onClaudeAccountsChanged } from "./providers/anthropic/account-events";
import { claudeAccountsInfo, refreshCombinedUsage } from "./providers/anthropic/account-pool";
import { listAccounts as listOpenAIAccounts } from "./providers/openai/auth";

/** Changes arrive in bursts (a turn's start, its usage, its end); one push per burst. */
const PUSH_DELAY_MS = 250;
/** While watched, idle usage and stale sign-ins are refreshed this often. */
const REFRESH_INTERVAL_MS = 60_000;

export interface AccountsWatchDeps {
  send: (client: ConnectedClient, event: Event) => void;
  /** The combined Claude usage changed after a refresh (the usage bars follow). */
  onClaudeUsage?: (usage: UsageData | null) => void;
  claudeInfo?: typeof claudeAccountsInfo;
  openaiAccounts?: () => OpenAIAccountInfo[];
  refreshClaude?: () => Promise<UsageData | null>;
  isProxied?: (provider: "anthropic" | "openai") => boolean;
  /** The /proxy remote's Claude pool, when Claude goes through /proxy and the remote shares it. */
  proxiedClaude?: typeof proxiedClaudeAccounts;
  /** Have the /proxy remote refresh its pool's sign-ins and usage. */
  refreshProxiedClaude?: () => Promise<UsageData | null>;
}

async function refreshProxiedClaudeUsage(): Promise<UsageData | null> {
  await providerProxyHooks()?.refreshUsage("anthropic");
  return getLastUsage("anthropic");
}

function defaultOpenAIAccounts(): OpenAIAccountInfo[] {
  return listOpenAIAccounts().map(({ index, email, displayName, plan, current }) => ({ index, email, displayName, plan, current }));
}

export function createAccountsWatch(deps: AccountsWatchDeps) {
  const claudeInfo = deps.claudeInfo ?? claudeAccountsInfo;
  const openaiAccounts = deps.openaiAccounts ?? defaultOpenAIAccounts;
  const refreshClaude = deps.refreshClaude ?? refreshCombinedUsage;
  const isProxied = deps.isProxied ?? isProviderProxied;
  const proxiedClaude = deps.proxiedClaude ?? proxiedClaudeAccounts;
  const refreshProxiedClaude = deps.refreshProxiedClaude ?? refreshProxiedClaudeUsage;
  const watchers = new Map<ConnectedClient, { convId: string | null }>();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let refreshing: Promise<void> | null = null;
  /** Several Claude accounts to keep fresh (an OpenAI pool alone needs no Claude checks). */
  let claudePool = false;
  /** Those accounts are the /proxy remote's. */
  let claudeRemote = false;

  const snapshot = (convId: string | null): AccountsSnapshot => {
    let claude = claudeInfo(convId);
    const remote = claude.proxied ? proxiedClaude() : null;
    if (remote) claude = mergeRemoteAccounts(claude, remote.pool, remote.remote);
    claudePool = !claude.proxied && claude.accounts.length > 1;
    claudeRemote = remote !== null;
    const openaiProxied = isProxied("openai");
    const openai = openaiAccounts();
    return {
      generatedAt: Date.now(),
      enabled: (!claude.proxied && claude.accounts.length > 1) || (!openaiProxied && openai.length > 1),
      claude,
      openai: { proxied: openaiProxied, accounts: openai },
    };
  };

  const stopIfIdle = () => {
    if (watchers.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const pushAll = () => {
    pushTimer = null;
    for (const [client, watch] of watchers) {
      if (client.socket.destroyed) {
        watchers.delete(client);
        continue;
      }
      deps.send(client, { type: "accounts", snapshot: snapshot(watch.convId) });
    }
    stopIfIdle();
  };

  const changed = () => {
    if (pushTimer || watchers.size === 0) return;
    pushTimer = setTimeout(pushAll, PUSH_DELAY_MS);
    (pushTimer as { unref?: () => void }).unref?.();
  };

  const refresh = () => {
    if (refreshing || !claudePool) return;
    refreshing = (claudeRemote ? refreshProxiedClaude() : refreshClaude()).then((usage) => {
      deps.onClaudeUsage?.(usage);
      changed();
    }).catch((error) => {
      log("debug", `accounts: refresh failed: ${error instanceof Error ? error.message : error}`);
    }).finally(() => {
      refreshing = null;
    });
  };

  const handle = (client: ConnectedClient, cmd: AccountsCommand): void => {
    const convId = typeof cmd.convId === "string" && cmd.convId ? cmd.convId : null;
    const current = snapshot(convId);
    deps.send(client, { type: "accounts", reqId: cmd.reqId, snapshot: current });
    if (cmd.watch === false || (cmd.watch && !current.enabled)) {
      watchers.delete(client);
      stopIfIdle();
      return;
    }
    if (!cmd.watch) return;
    watchers.set(client, { convId });
    unsubscribe ??= onClaudeAccountsChanged(changed);
    if (!refreshTimer) {
      refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
      (refreshTimer as { unref?: () => void }).unref?.();
    }
    refresh();
  };

  return {
    handle,
    /** Something the watchers show changed outside the Claude pool (an OpenAI account switch). */
    changed,
    watcherCount: () => watchers.size,
    /** Settles once a running refresh is done (tests). */
    settled: () => refreshing ?? Promise.resolve(),
  };
}
