import { claudeAccountStates, proxyDownCreditInMs, refreshCombinedUsage } from "./account-pool";
import { chooseAccountForNewWork, DEFAULT_ROUTING_POLICY, type AccountRouteState } from "./routing";
import { isProviderProxied, proxiedClaudeAccounts } from "../../provider-proxy/route";
import type { UsageAvailability } from "../../usage-limit-wait";
import { applyDevRoutingOverrides } from "./routing-dev-overrides";
import { apiCreditFallbackEnabled, apiCreditResetAt, knownApiCreditSecrets, refreshApiCreditSecrets, usableApiCreditKey } from "./api-credits";
import { getClaudeCodeSession } from "./session";

let nextRefreshAt = 0;

function localApiCredits(now: number): { ready: boolean; resetAt: number | null } | null {
  if (!apiCreditFallbackEnabled()) return null;
  // Which keys exist is not known until the secrets store is first checked:
  // let the turn try, its routing waits for that check and decides.
  if (!knownApiCreditSecrets()) {
    void refreshApiCreditSecrets();
    return { ready: true, resetAt: null };
  }
  return { ready: usableApiCreditKey(now) !== null, resetAt: apiCreditResetAt(now) };
}

/**
 * While the /proxy link is down: how long until the conversation's retried
 * request runs on this machine's API credits (0: now). Null when it will not:
 * a process with background tasks stays on the link, as routing keeps it.
 */
export function claudeProxyFallbackInMs(convId: string, now = Date.now()): number | null {
  const live = getClaudeCodeSession(convId);
  if (live && !live.isClosed && live.hasBackgroundWork && !live.apiCredit) return null;
  return proxyDownCreditInMs(convId, now);
}

/** `apiCredits: false`: the conversation may not use API credits (an app's `route.credits: "never"`). */
export function claudeUsageAvailability(now = Date.now(), options: { apiCredits?: boolean } = {}): UsageAvailability {
  // /proxy is down and this machine's keys take over: the remote's last known limits don't apply.
  if (options.apiCredits !== false && proxyDownCreditInMs(undefined, now) === 0) return { ready: true, resetAt: null };
  const remote = proxiedClaudeAccounts()?.pool;
  if (isProviderProxied("anthropic") && !remote) return { ready: true, resetAt: null };
  const local = applyDevRoutingOverrides(claudeAccountStates(now), now);
  const states: AccountRouteState[] = remote ? remote.accounts.map(account => ({
    id: account.id, available: account.state === "ready" || account.state === "limited",
    limitedUntil: account.limitedUntil, usage: account.usage, activeTurns: account.activeTurns,
  })) : local.states;
  // Do not turn authentication/configuration errors into indefinite usage waits.
  const eligible = states.filter(account => account.available);
  // A remote daemon from before pace routing sends no pace fields: the defaults fill them.
  const policy = remote ? { ...DEFAULT_ROUTING_POLICY, ...remote.routing } : local.policy;
  if (!eligible.length || chooseAccountForNewWork(states, now, policy)) {
    return { ready: true, resetAt: null };
  }
  // Every subscription account is at a limit: API credits can take the turn (api-credits.ts).
  const credits = options.apiCredits === false ? null : remote ? remote.combined?.apiCredits ?? null : localApiCredits(now);
  if (credits?.ready) return { ready: true, resetAt: null };
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
  // A rate-limited key may be back before any subscription resets.
  if (credits?.resetAt && credits.resetAt > now) resets.push(credits.resetAt);
  return { ready: false, resetAt: resets.length ? Math.min(...resets) : null };
}
