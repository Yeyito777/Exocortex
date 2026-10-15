/**
 * The Claude account pool across /proxy (docs/provider-proxy.md).
 *
 * The remote daemon shares its pool (accounts, usage, running turns and warm
 * conversations) over the link: `remoteAccountsSource` is what it sends. The
 * local daemon shows that pool as its own in the usage bars and on the
 * Accounts screen: `withMainUsage` keeps it current between pushes, and
 * `mergeRemoteAccounts` adds this machine's conversations, which run on the
 * remote's `main` account.
 */

import type { AccountConversationInfo, ClaudeAccountInfo, ClaudeAccountsInfo, ClaudeAccountsRemoteInfo } from "@exocortex/shared/protocol";
import type { ProviderProxyRemoteAccounts } from "@exocortex/shared/provider-proxy";
import type { UsageData } from "../messages";
import { onClaudeAccountsChanged } from "../providers/anthropic/account-events";
import { claudeAccountsInfo } from "../providers/anthropic/account-pool";
import { MAIN_ACCOUNT_ID } from "../providers/anthropic/accounts";
import { aggregateUsage } from "../providers/anthropic/usage";
import { isProviderProxied } from "./route";

/** What a remote daemon shares about its Claude pool; tests substitute it. */
export interface RemoteAccountsSource {
  /** The pool now, or null when there is none to share (this daemon proxies Claude itself). */
  snapshot(): ProviderProxyRemoteAccounts | null;
  /** Call `listener` after the pool changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** This daemon's pool, as its own Accounts screen sees it. */
export function remoteAccountsSource(): RemoteAccountsSource {
  return {
    snapshot() {
      if (isProviderProxied("anthropic")) return null;
      const { currentConversation: _current, ...info } = claudeAccountsInfo(null);
      return info;
    },
    subscribe: onClaudeAccountsChanged,
  };
}

/** Accounts whose usage the remote's combined bars add up: signed in with a subscription and not blocked. */
function countsTowardCapacity(account: ClaudeAccountInfo): boolean {
  return account.state === "ready" || account.state === "limited";
}

/**
 * The pool with fresher usage for `main`, which runs this machine's proxied
 * turns (their rate-limit events arrive here before the remote hears of them).
 * The combined bars are recomputed when the accounts they add up are known.
 */
export function withMainUsage(pool: ProviderProxyRemoteAccounts, usage: UsageData, now = Date.now()): ProviderProxyRemoteAccounts {
  if (!pool.accounts.some(account => account.id === MAIN_ACCOUNT_ID)) return pool;
  const accounts = pool.accounts.map(account => account.id === MAIN_ACCOUNT_ID ? { ...account, usage, usageUpdatedAt: now } : account);
  const included = accounts.filter(countsTowardCapacity);
  const capacity = pool.combined?.capacity ?? (pool.combined ? 100 : null);
  const sameAccounts = included.some(account => account.id === MAIN_ACCOUNT_ID) && capacity === included.length * 100;
  return {
    ...pool,
    accounts,
    combined: sameAccounts ? aggregateUsage(included.map(account => account.usage), now) : pool.combined,
  };
}

/**
 * The Accounts screen's Claude data while Claude goes through /proxy and the
 * remote shared its pool: the remote's accounts, with this machine's own
 * conversations listed under `main` (openable here; the remote's rows are not).
 */
export function mergeRemoteAccounts(local: ClaudeAccountsInfo, pool: ProviderProxyRemoteAccounts, remote: ClaudeAccountsRemoteInfo): ClaudeAccountsInfo {
  const localMain = local.accounts.find(account => account.id === MAIN_ACCOUNT_ID);
  const ownRows = localMain?.conversations ?? [];
  const accounts = pool.accounts.map((account): ClaudeAccountInfo => {
    const remoteRows: AccountConversationInfo[] = account.conversations.map(conv => ({ ...conv, remote: true }));
    if (account.id !== MAIN_ACCOUNT_ID) return { ...account, conversations: remoteRows };
    const conversations = [...ownRows, ...remoteRows]
      .sort((a, b) => Number(b.running) - Number(a.running) || b.lastUsedAt - a.lastUsedAt);
    return { ...account, activeTurns: account.activeTurns + (localMain?.activeTurns ?? 0), conversations };
  });
  const hasMain = accounts.some(account => account.id === MAIN_ACCOUNT_ID);
  return {
    proxied: false,
    remote,
    accounts,
    combined: pool.combined,
    routing: pool.routing,
    // The remote picks accounts for its own work; turns from here always use its main login.
    nextNewWork: hasMain ? { account: MAIN_ACCOUNT_ID, detail: `turns from here use ${remote.alias}'s main` } : pool.nextNewWork,
    ...(local.currentConversation ? { currentConversation: local.currentConversation } : {}),
  };
}
