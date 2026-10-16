import { claudeAccountStates, refreshCombinedUsage } from "./account-pool";
import { chooseAccountForNewWork, DEFAULT_ROUTING_POLICY, type AccountRouteState } from "./routing";
import { isProviderProxied, proxiedClaudeAccounts } from "../../provider-proxy/route";
import type { UsageAvailability } from "../../usage-limit-wait";
import { applyDevRoutingOverrides } from "./routing-dev-overrides";

let nextRefreshAt = 0;

export function claudeUsageAvailability(now = Date.now()): UsageAvailability {
  const remote = proxiedClaudeAccounts()?.pool;
  if (isProviderProxied("anthropic") && !remote) return { ready: true, resetAt: null };
  const local = applyDevRoutingOverrides(claudeAccountStates(now), now);
  const states: AccountRouteState[] = remote ? remote.accounts.map(account => ({
    id: account.id, available: account.state === "ready" || account.state === "limited",
    limitedUntil: account.limitedUntil, usage: account.usage, activeTurns: account.activeTurns,
  })) : local.states;
  // Do not turn authentication/configuration errors into indefinite usage waits.
  const eligible = states.filter(account => account.available);
  if (!eligible.length || chooseAccountForNewWork(states, now, remote?.routing ?? local.policy ?? DEFAULT_ROUTING_POLICY)) {
    return { ready: true, resetAt: null };
  }
  const resets = eligible.map(account => Math.max(
    account.limitedUntil ?? 0,
    ...[account.usage?.fiveHour, account.usage?.sevenDay]
      .filter(window => window && window.utilization >= 100 && (window.resetsAt ?? 0) > now)
      .map(window => window!.resetsAt!),
  )).filter(reset => reset > now);
  if (!remote && !isProviderProxied("anthropic") && now >= nextRefreshAt) {
    nextRefreshAt = now + 60_000;
    // Shared cached/in-flight refreshes; never hold a turn's abort hostage to
    // a helper process. The next capacity probe observes the new snapshot.
    void refreshCombinedUsage().catch(() => {});
  }
  return { ready: false, resetAt: resets.length ? Math.min(...resets) : null };
}
