/**
 * The remote side of /proxy for Claude: which of this daemon's Claude
 * accounts serves each proxied request (docs/provider-proxy.md).
 *
 * Proxied requests are routed exactly as this daemon's own turns
 * (routeClaudeTurn in account-pool.ts, rules in routing.ts): a conversation
 * stays on its account while its prompt cache is warm, new work goes to the
 * account whose capacity expires soonest above the floors, and limited or
 * blocked accounts are skipped. The proxied conversation is identified by the
 * client's PROVIDER_PROXY_CONVERSATION_HEADER (`<client host>/<conversation
 * id>`), kept here as `proxy:<that>`. Each response's rate-limit headers
 * update the account that served it.
 *
 * While every account is at a usage limit, Messages API requests run on an
 * API-credit key instead (providers/anthropic/api-credits.ts), as this
 * daemon's own turns do: the lease names the key, upstream-auth.ts signs the
 * request with it, and what it spends is counted from the response stream.
 */

import { CLAUDE_RATE_LIMIT_HEADER, CLAUDE_ACCOUNT_HEADER, applyUsageHeaders } from "../providers/anthropic/usage";
import { beginAccountTurn, beginApiCreditTurn, getConversationAccount, multipleClaudeAccounts, noteAccountAuthFailure, routeClaudeTurn, touchConversationAccount } from "../providers/anthropic/account-pool";
import type { RouteDecision } from "../providers/anthropic/routing";
import { MAIN_ACCOUNT_ID } from "../providers/anthropic/accounts";
import {
  ApiCreditUsageMeter,
  isApiCreditRefusalText,
  markApiCreditRejected,
  markApiCreditSpent,
  markApiCreditThrottled,
  type ApiCreditKey,
} from "../providers/anthropic/api-credits";
import { log } from "../log";

/** Assignment keys of proxied conversations start with this. */
export const PROXIED_CONVERSATION_PREFIX = "proxy:";

/** A client's conversation identity, if it is a sane one. */
export function proxiedConversationKey(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9._@:-]{1,128}\/[A-Za-z0-9._-]{1,128}$/.test(value)) return null;
  return PROXIED_CONVERSATION_PREFIX + value;
}

/** One proxied request's account, held while its response streams. */
export interface ProxiedClaudeLease {
  account: string;
  /** Set when the request is billed to an API-credit key instead of the account's subscription. */
  apiCredit: ApiCreditKey | null;
  /** Set when the request moved its conversation off the account it last used. */
  moved: { from: string; detail: string } | null;
  /**
   * The upstream answered: record its rate-limit headers on this account.
   * Returns true when it refused the request at a usage limit, or (API
   * credits) for lack of credits or a rate limit; `errorText` is an error
   * response's body, read only for API-credit leases.
   */
  observe(status: number, headers: Headers, errorText?: string): boolean;
  /** API-credit leases: counts what the response stream spends. */
  meter: ApiCreditUsageMeter | null;
  /** Its login was rejected even after a refresh. */
  authFailed(reason: string): void;
  release(): void;
}

export interface ProxiedClaudeRouter {
  /**
   * Pick the account for a request of `conversation` (null: not tied to one,
   * e.g. a title). `apiCredits`: the request may run on API credits (Messages
   * API requests; Claude Code's account endpoints need the subscription login).
   */
  lease(conversation: string | null, signal?: AbortSignal, options?: { apiCredits?: boolean }): Promise<ProxiedClaudeLease>;
}

function number(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * An upstream response's `anthropic-ratelimit-unified-*` headers as the
 * rate_limit_event info Claude Code would report for them (usage.ts reads
 * that), or null when the limiter did not run.
 */
export function rateLimitInfoFromHeaders(headers: Headers): Record<string, unknown> | null {
  const status = headers.get("anthropic-ratelimit-unified-status");
  if (!status) return null;
  const windows: Record<string, { utilization?: number; resetsAt?: number }> = {};
  for (const [name, short] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const utilization = number(headers.get(`anthropic-ratelimit-unified-${short}-utilization`));
    const resetsAt = number(headers.get(`anthropic-ratelimit-unified-${short}-reset`));
    if (utilization === undefined && resetsAt === undefined) continue;
    windows[name] = { ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
  }
  const overage = headers.get("anthropic-ratelimit-unified-overage-status");
  const resetsAt = number(headers.get("anthropic-ratelimit-unified-reset"));
  return {
    status,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    // Refused by the plan but carried on extra usage: Exocortex keeps work off such an account, as for its own turns.
    ...(status === "rejected" && (overage === "allowed" || overage === "allowed_warning") ? { isUsingOverage: true } : {}),
    unifiedWindows: windows,
  };
}

export interface ProxiedClaudeRouterDeps {
  route?: (key: string | undefined, signal?: AbortSignal) => Promise<RouteDecision & { apiCredit?: ApiCreditKey | null }>;
}

export function createProxiedClaudeRouter(deps: ProxiedClaudeRouterDeps = {}): ProxiedClaudeRouter {
  const route = deps.route ?? ((key, signal) => routeClaudeTurn(key, null, signal));
  return {
    async lease(conversation, signal, options = {}) {
      const key = conversation ?? undefined;
      const previous = key ? getConversationAccount(key)?.account ?? null : null;
      const decision = await route(key, signal);
      const account = decision.account;
      const apiCredit = options.apiCredits ? decision.apiCredit ?? null : null;
      if (apiCredit) {
        log("info", `provider-proxy: ${key ?? "a proxied helper request"} runs on API credits "${apiCredit.label}" (every Claude subscription account is at a usage limit)`);
        const endCreditTurn = beginApiCreditTurn();
        const meter = new ApiCreditUsageMeter(apiCredit);
        let rejections = 0;
        return {
          account,
          apiCredit,
          moved: null,
          meter,
          observe(status, _headers, errorText = "") {
            if (status === 401) {
              // Retried once with the key read again; a second rejection sets it aside.
              if (++rejections >= 2) markApiCreditRejected(apiCredit, `HTTP 401 ${errorText}`.trim());
              return false;
            }
            if (status === 429) {
              markApiCreditThrottled(apiCredit);
              return true;
            }
            if (status >= 400 && isApiCreditRefusalText(errorText)) {
              markApiCreditSpent(apiCredit, `HTTP ${status}: ${errorText}`.replace(/\s+/g, " ").slice(0, 200));
              return true;
            }
            return false;
          },
          authFailed(reason) {
            markApiCreditRejected(apiCredit, reason);
          },
          release() {
            meter.flushAll();
            endCreditTurn();
          },
        };
      }
      if (decision.movedFrom) {
        log("info", `provider-proxy: proxied conversation ${key} moves from Claude account ${decision.movedFrom} to ${account} (${decision.reason}: ${decision.detail})`);
      } else if (multipleClaudeAccounts() && previous !== account) {
        log("info", `provider-proxy: Claude account ${account} for ${key ?? "a proxied helper request"} (${decision.reason}: ${decision.detail})`);
      }
      if (key) touchConversationAccount(key, account);
      const endTurn = beginAccountTurn(account, key);
      return {
        account,
        apiCredit: null,
        meter: null,
        moved: decision.movedFrom ? { from: decision.movedFrom, detail: decision.detail } : null,
        observe(status, headers) {
          const info = rateLimitInfoFromHeaders(headers);
          if (info) {
            applyUsageHeaders(new Headers({
              [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(info),
              ...(account !== MAIN_ACCOUNT_ID ? { [CLAUDE_ACCOUNT_HEADER]: account } : {}),
            }));
          }
          return status === 429 && info?.status === "rejected";
        },
        authFailed(reason) {
          noteAccountAuthFailure(account, reason);
        },
        release() {
          if (key) touchConversationAccount(key, account);
          endTurn();
        },
      };
    },
  };
}
