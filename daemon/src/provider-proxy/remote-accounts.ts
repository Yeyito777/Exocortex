/**
 * The Claude account pool across /proxy (docs/provider-proxy.md).
 *
 * The remote daemon shares its pool (accounts, usage, running turns and warm
 * conversations) over the link: `remoteAccountsSource` is what it sends. The
 * local daemon shows that pool as its own in the usage bars and on the
 * Accounts screen (`mergeRemoteAccounts`). The remote routes this machine's
 * proxied turns across that pool, so its routing is this machine's too.
 */

import type { AccountConversationInfo, ClaudeAccountInfo, ClaudeAccountsInfo, ClaudeAccountsRemoteInfo } from "@exocortex/shared/protocol";
import type { ProviderProxyRemoteAccounts } from "@exocortex/shared/provider-proxy";
import { onClaudeAccountsChanged } from "../providers/anthropic/account-events";
import { claudeAccountsInfo } from "../providers/anthropic/account-pool";
import { PROXIED_CONVERSATION_PREFIX } from "./claude-routing";
import { isProviderProxied, proxiedConversationName } from "./route";

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

/**
 * The Accounts screen's Claude data while Claude goes through /proxy and the
 * remote shared its pool: the remote's accounts, routing and usage. The
 * remote routes this machine's proxied conversations across its pool under
 * `proxy:<this host>/<conversation id>` (claude-routing.ts); those rows are
 * this machine's conversations again, the remote's own are marked `remote`.
 */
export function mergeRemoteAccounts(
  local: ClaudeAccountsInfo,
  pool: ProviderProxyRemoteAccounts,
  remote: ClaudeAccountsRemoteInfo,
  ownPrefix = PROXIED_CONVERSATION_PREFIX + proxiedConversationName(""),
): ClaudeAccountsInfo {
  const accounts = pool.accounts.map((account): ClaudeAccountInfo => ({
    ...account,
    conversations: account.conversations.map((conv): AccountConversationInfo => conv.convId.startsWith(ownPrefix)
      ? { ...conv, convId: conv.convId.slice(ownPrefix.length) }
      : { ...conv, remote: true }),
  }));
  const currentId = local.currentConversation?.convId;
  let currentConversation = local.currentConversation;
  if (currentId) {
    const holder = accounts.find(account => account.conversations.some(conv => conv.convId === currentId && !conv.remote));
    const row = holder?.conversations.find(conv => conv.convId === currentId && !conv.remote);
    currentConversation = { convId: currentId, account: holder?.id ?? null, lastUsedAt: row?.lastUsedAt ?? null, warm: row?.warm ?? false };
  }
  return {
    proxied: false,
    remote,
    accounts,
    combined: pool.combined,
    routing: pool.routing,
    nextNewWork: pool.nextNewWork,
    ...(currentConversation ? { currentConversation } : {}),
  };
}
